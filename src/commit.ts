import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as http from "node:http";
import * as https from "node:https";
import * as fs from "node:fs";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

export type CommandRepository = {
  rootUri: vscode.Uri;
  inputBox: { value: string };
};

export type GitApi = {
  repositories: CommandRepository[];
};

export type ScmCommandContext = {
  _rootUri?: vscode.Uri;
  rootUri?: vscode.Uri;
};

type OllamaResponse = {
  // Ollama native format
  message?: { role: string; content: string };
  // OpenAI-compatible format
  choices?: { message?: { role: string; content: string } }[];
  error?: string;
};

type DebugContext = {
  enabled: boolean;
  output: vscode.OutputChannel;
};

export async function generateCommitMessages(
  output: vscode.OutputChannel,
  scmContext?: ScmCommandContext,
): Promise<void> {
  const git = getGitApi();
  if (!git) {
    throw new Error("VS Code Git extension is unavailable.");
  }

  const config = vscode.workspace.getConfiguration("gitKit");
  const debug = config.get<boolean>("debug", true);
  const apiUrl = config
    .get<string>("apiUrl", "http://127.0.0.1:11434/api/chat")
    .trim();
  const model = config.get<string>("model", "qwen3.5:2b");
  const systemPrompt = config.get<string>(
    "systemPrompt",
    [
      "Generate exactly one conventional commit message for the staged git changes below.",
      "Rules:",
      "- Return only the final commit message.",
      "- Prefer a single-line subject with no body.",
      "- Keep the subject concise and ideally under 72 characters.",
      "- Use imperative mood.",
      "- Choose the most accurate conventional type such as feat, fix, refactor, docs, test, chore, build, ci, perf, or style.",
    ].join("\n"),
  );
  const diffMaxChars = config.get<number>("diffMaxChars", 4000);
  const requestTimeoutMs = config.get<number>("requestTimeoutMs", 60000);
  const applyToAllRepositories = config.get<boolean>(
    "applyToAllRepositories",
    true,
  );
  const debugContext: DebugContext = { enabled: debug, output };

  log(debugContext, `Using Ollama API URL ${apiUrl}`);
  log(debugContext, `Using model ${model}`);
  log(debugContext, `Using timeout ${requestTimeoutMs}ms`);
  log(debugContext, `Detected ${git.repositories.length} open repositories`);

  const repositories = resolveRepositories(
    git,
    scmContext,
    applyToAllRepositories,
  );
  if (repositories.length === 0) {
    throw new Error("No matching git repository was found.");
  }

  for (const repository of repositories) {
    await generateCommitMessageForRepository(
      repository,
      output,
      debugContext,
      apiUrl,
      model,
      systemPrompt,
      diffMaxChars,
      requestTimeoutMs,
    );
  }

  void vscode.window.showInformationMessage(
    repositories.length === 1
      ? "Commit message generated."
      : `Generated commit messages for ${repositories.length} repositories.`,
  );
}

async function generateCommitMessageForRepository(
  repository: CommandRepository,
  output: vscode.OutputChannel,
  debug: DebugContext,
  apiUrl: string,
  model: string,
  systemPrompt: string,
  diffMaxChars: number,
  requestTimeoutMs: number,
): Promise<void> {
  const repoPath = repository.rootUri.fsPath;
  output.appendLine(`[info] Collecting staged changes for ${repoPath}`);
  log(debug, `Collecting staged diff for ${repoPath}`);

  const stagedDiff = await collectStagedDiff(repoPath, diffMaxChars, debug);

  const prompt = buildUserPrompt(stagedDiff);

  const payload = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ],
    stream: false,
    think: false,
    options: { temperature: 0.1, num_ctx: 8192, num_predict: 256 },
    keep_alive: "10m",
  };

  if (debug.enabled) {
    const requestFile = path.join(repoPath, "git-kit-request.json");
    fs.writeFileSync(requestFile, JSON.stringify(payload, null, 2), "utf8");
    output.appendLine(`[debug] Request body written to ${requestFile}`);
  }

  output.appendLine(`[info] Sending request to ${apiUrl}`);
  log(debug, `Sending request to ${apiUrl} for ${repoPath}`);
  const response = await requestOllama(apiUrl, requestTimeoutMs, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const rawText = await response.text();
  log(
    debug,
    `Received response ${response.status} ${response.statusText} for ${repoPath}`,
  );
  if (!response.ok) {
    throw new Error(`Ollama API returned ${response.status}: ${rawText}`);
  }

  const parsed = JSON.parse(rawText) as OllamaResponse;
  if (parsed.error) {
    throw new Error(parsed.error);
  }

  const rawContent =
    parsed.message?.content ?? parsed.choices?.[0]?.message?.content;
  const commitMessage = sanitizeCommitMessage(rawContent);
  if (!commitMessage) {
    throw new Error("Ollama returned an empty commit message.");
  }

  await vscode.env.clipboard.writeText(commitMessage);
  repository.inputBox.value = commitMessage;
  output.appendLine(`[info] Commit message applied for ${repoPath}`);
  log(debug, `Commit message generated: ${commitMessage}`);
}

async function collectStagedDiff(
  cwd: string,
  diffMaxChars: number,
  debug: DebugContext,
): Promise<string> {
  log(debug, `Running staged diff collection for ${cwd}`);
  const diff = await runGit(
    ["diff", "--cached", "--no-ext-diff", "--unified=3", "--find-renames"],
    cwd,
    debug,
  );

  if (!diff.trim()) {
    throw new Error(
      "No staged changes found. Stage your changes before generating a commit message.",
    );
  }

  const compact = (text: string): string =>
    text
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .join("\n");

  return compact(diff).slice(0, diffMaxChars);
}

async function runGit(
  args: string[],
  cwd: string,
  debug: DebugContext,
): Promise<string> {
  log(debug, `Running git ${args.join(" ")} in ${cwd}`);
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 1024 * 1024 * 8,
    });
    return stdout.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args.join(" ")} failed: ${message}`);
  }
}

function buildUserPrompt(stagedDiff: string): string {
  return ["Staged changes:", stagedDiff].join("\n");
}

function sanitizeCommitMessage(value?: string): string {
  const cleaned = (value ?? "")
    .replace(/<think[\s\S]*?<\/think>/gi, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^commit message\s*:\s*/i, "")
    .replace(/^message\s*:\s*/i, "")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "");

  const lines = cleaned
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .map((line) => line.replace(/^\d+\.\s+/, "").trim())
    .map((line) => line.replace(/^["'`]+|["'`]+$/g, "").trim());

  if (lines.length === 0) {
    return "";
  }

  const preferredLine =
    lines.find((line) => /^[a-z]+(\([^)]+\))?!?:\s+\S+/i.test(line)) ??
    lines.find((line) => line.includes(":")) ??
    lines[0];

  return preferredLine.trim();
}

function log(debug: DebugContext, message: string): void {
  if (!debug.enabled) {
    return;
  }

  debug.output.appendLine(`[debug ${new Date().toISOString()}] ${message}`);
}

type OllamaRequestOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

type OllamaHttpResponse = {
  status: number;
  statusText: string;
  ok: boolean;
  text(): Promise<string>;
};

async function requestOllama(
  input: string,
  timeoutMs: number,
  options?: OllamaRequestOptions,
): Promise<OllamaHttpResponse> {
  let url: URL;
  try {
    url = new URL(input);
  } catch (error) {
    throw new Error(`Invalid Ollama API URL: ${input}: ${String(error)}`);
  }

  const transport = url.protocol === "https:" ? https : http;

  return new Promise<OllamaHttpResponse>((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: options?.method ?? "GET",
        headers: options?.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) =>
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
        );
        response.on("end", () => {
          const rawText = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode ?? 0,
            statusText: response.statusMessage ?? "",
            ok:
              (response.statusCode ?? 0) >= 200 &&
              (response.statusCode ?? 0) < 300,
            text: async () => rawText,
          });
        });
      },
    );

    request.setTimeout(timeoutMs, () =>
      request.destroy(new Error(`Request timed out after ${timeoutMs}ms`)),
    );
    request.on("error", (error) =>
      reject(new Error(`Failed to reach Ollama at ${input}: ${error.message}`)),
    );

    if (options?.body) {
      request.write(options.body);
    }
    request.end();
  });
}

function getGitApi(): GitApi | undefined {
  const extension = vscode.extensions.getExtension<{
    getAPI(version: number): GitApi;
  }>("vscode.git");
  return extension?.exports?.getAPI(1);
}

function resolveRepositories(
  git: GitApi,
  scmContext: ScmCommandContext | undefined,
  applyToAllRepositories: boolean,
): CommandRepository[] {
  const contextPath =
    scmContext?._rootUri?.fsPath ?? scmContext?.rootUri?.fsPath;
  if (contextPath) {
    return git.repositories.filter((r) => r.rootUri.fsPath === contextPath);
  }

  if (applyToAllRepositories) {
    return git.repositories;
  }

  const activeWorkspacePath =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!activeWorkspacePath) {
    return [];
  }

  return git.repositories.filter(
    (r) => r.rootUri.fsPath === activeWorkspacePath,
  );
}
