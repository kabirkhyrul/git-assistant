import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as http from 'node:http';
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);
const verifiedOllamaModels = new Set<string>();

type CommandRepository = {
  rootUri: vscode.Uri;
  inputBox: {
    value: string;
  };
};

type GitApi = {
  repositories: CommandRepository[];
};

type ScmCommandContext = {
  _rootUri?: vscode.Uri;
  rootUri?: vscode.Uri;
};

type OllamaResponse = {
  message?: { role: string; content: string };
  total_duration?: number;
  load_duration?: number;
  eval_duration?: number;
  error?: string;
};

type OllamaTagsResponse = {
  models?: Array<{
    name?: string;
    model?: string;
  }>;
};

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

type GitContext = {
  text: string;
  hasStagedChanges: boolean;
};

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Git Assistant');

  const disposable = vscode.commands.registerCommand('gitAssistant.generateCommitMessage', async (scmContext?: ScmCommandContext) => {
    output.show(true);

    try {
      await generateCommitMessages(output, scmContext);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`[error] ${message}`);
      void vscode.window.showErrorMessage(`Git Assistant failed: ${message}`);
    }
  });

  const toggleExcludeDisposable = vscode.commands.registerCommand('gitAssistant.toggleExcludeFile', async (uri?: vscode.Uri) => {
    try {
      const target = await resolveTargetUri(uri);
      await toggleExcludeFile(target, output);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`[error] ${message}`);
      void vscode.window.showErrorMessage(`Git Assistant failed: ${message}`);
    }
  });

  const checkoutFromBranchDisposable = vscode.commands.registerCommand('gitAssistant.checkoutFileFromBranch', async (uri?: vscode.Uri) => {
    try {
      const target = await resolveTargetUri(uri);
      await checkoutFileFromBranch(target, output);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`[error] ${message}`);
      void vscode.window.showErrorMessage(`Git Assistant failed: ${message}`);
    }
  });

  context.subscriptions.push(disposable, toggleExcludeDisposable, checkoutFromBranchDisposable, output);
}

export function deactivate(): void {}

async function generateCommitMessages(output: vscode.OutputChannel, scmContext?: ScmCommandContext): Promise<void> {
  const git = getGitApi();
  if (!git) {
    throw new Error('VS Code Git extension is unavailable.');
  }

  const config = vscode.workspace.getConfiguration('gitAssistant');
  const debug = config.get<boolean>('debug', true);
  const apiUrl = config.get<string>('apiUrl', 'http://127.0.0.1:11434/api/chat').trim();
  const model = config.get<string>('model', 'qwen3.5:2b');
  const systemPrompt = config.get<string>(
    'systemPrompt',
    'You write concise, high-quality conventional commit messages. Return only the final commit message. Prefer a single line. Use imperative mood.'
  );
  const diffMaxChars = config.get<number>('diffMaxChars', 4000);
  const requestTimeoutMs = config.get<number>('requestTimeoutMs', 600000);
  const applyToAllRepositories = config.get<boolean>('applyToAllRepositories', true);

  log(output, debug, `Starting generation with model "${model}"`);
  log(output, debug, `Using Ollama API URL ${apiUrl}`);
  log(output, debug, `Using Ollama timeout ${requestTimeoutMs}ms`);
  log(output, debug, `Detected ${git.repositories.length} open repositories`);

  await ensureOllamaModelAvailable(apiUrl, model, output, debug, requestTimeoutMs);

  const repositories = resolveRepositories(git, scmContext, applyToAllRepositories);
  if (repositories.length === 0) {
    throw new Error('No matching git repository was found.');
  }

  log(output, debug, `Processing ${repositories.length} repositor${repositories.length === 1 ? 'y' : 'ies'}`);

  const generatedMessages: string[] = [];
  for (const repository of repositories) {
    const commitMessage = await generateCommitMessageForRepository(
      repository,
      output,
      debug,
      apiUrl,
      model,
      systemPrompt,
      diffMaxChars,
      requestTimeoutMs
    );
    generatedMessages.push(commitMessage);
  }

  if (generatedMessages.length === 1) {
    void vscode.window.showInformationMessage('Commit message generated and copied to clipboard.');
    return;
  }

  void vscode.window.showInformationMessage(`Generated commit messages for ${generatedMessages.length} repositories.`);
}

async function generateCommitMessageForRepository(
  repository: CommandRepository,
  output: vscode.OutputChannel,
  debug: boolean,
  apiUrl: string,
  model: string,
  systemPrompt: string,
  diffMaxChars: number,
  requestTimeoutMs: number
): Promise<string> {
  const repoPath = repository.rootUri.fsPath;
  log(output, debug, `Collecting changes for ${repoPath}`);

  const gitContext = await collectGitContext(repoPath, output, debug, diffMaxChars);
  const prompt = buildPrompt(gitContext);
  log(output, debug, `Preparing Ollama request for ${repoPath}`);

  const payload = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt }
    ],
    stream: false,
    options: { temperature: 0.1, num_ctx: 2048, num_predict: 64 },
    keep_alive: '10m'
  };

  log(output, debug, `Sending request to Ollama for ${repoPath}`);

  const response = await requestOllama(apiUrl, requestTimeoutMs, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  log(output, debug, `Received Ollama response for ${repoPath} (${response.status} ${response.statusText})`);

  const rawText = await response.text();

  if (!response.ok) {
    throw new Error(`Ollama API returned ${response.status}: ${rawText}`);
  }

  const parsed = JSON.parse(rawText) as OllamaResponse;
  if (parsed.error) {
    throw new Error(parsed.error);
  }

  log(output, debug, `total_duration=${parsed.total_duration}, load_duration=${parsed.load_duration}, eval_duration=${parsed.eval_duration}`);

  const commitMessage = sanitizeCommitMessage(parsed.message?.content);
  if (!commitMessage) {
    throw new Error('Ollama returned an empty commit message.');
  }

  log(output, debug, `Applying generated commit message to SCM input for ${repoPath}`);

  await vscode.env.clipboard.writeText(commitMessage);
  repository.inputBox.value = commitMessage;
  log(output, debug, `Commit message applied for ${repoPath}`);
  return commitMessage;
}

async function collectGitContext(
  cwd: string,
  output: vscode.OutputChannel,
  debug: boolean,
  diffMaxChars: number
): Promise<GitContext> {
  const [
    status,
    stagedNameStatus,
    unstagedNameStatus,
    stagedStat,
    unstagedStat,
    stagedDiff,
    unstagedDiff,
    untrackedFiles
  ] = await Promise.all([
    runGit(['status', '--short'], cwd, output, debug),
    runGit(['diff', '--cached', '--name-status', '--find-renames'], cwd, output, debug),
    runGit(['diff', '--name-status', '--find-renames'], cwd, output, debug),
    runGit(['diff', '--cached', '--stat', '--find-renames'], cwd, output, debug),
    runGit(['diff', '--stat', '--find-renames'], cwd, output, debug),
    runGit(['diff', '--cached', '--no-ext-diff', '--unified=0', '--find-renames'], cwd, output, debug),
    runGit(['diff', '--no-ext-diff', '--unified=0', '--find-renames'], cwd, output, debug),
    runGit(['ls-files', '--others', '--exclude-standard'], cwd, output, debug)
  ]);

  const hasStagedChanges = Boolean(stagedNameStatus.trim() || stagedDiff.trim());
  const hasUnstagedChanges = Boolean(unstagedNameStatus.trim() || unstagedDiff.trim());
  const hasUntrackedFiles = Boolean(untrackedFiles.trim());

  if (!status.trim() && !hasStagedChanges && !hasUnstagedChanges && !hasUntrackedFiles) {
    throw new Error('No git changes found.');
  }

  const compact = (text: string): string =>
    text
      .split('\n')
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .join('\n');

  const focusLabel = hasStagedChanges ? 'staged' : 'working tree';
  const sections = [
    `COMMIT_FOCUS:\n${hasStagedChanges ? 'Prefer staged changes when generating the commit message.' : 'No staged changes found, analyze working tree changes.'}`,
    `STATUS:\n${compact(status) || '(empty)'}`,
    `UNTRACKED_FILES:\n${compact(untrackedFiles) || '(none)'}`
  ];

  if (hasStagedChanges) {
    sections.push(
      `STAGED_NAME_STATUS:\n${compact(stagedNameStatus) || '(empty)'}`,
      `STAGED_STAT:\n${compact(stagedStat) || '(empty)'}`,
      `STAGED_DIFF:\n${compact(stagedDiff) || '(empty)'}`
    );
  }

  if (!hasStagedChanges || hasUnstagedChanges || hasUntrackedFiles) {
    sections.push(
      `UNSTAGED_NAME_STATUS:\n${compact(unstagedNameStatus) || '(empty)'}`,
      `UNSTAGED_STAT:\n${compact(unstagedStat) || '(empty)'}`,
      `UNSTAGED_DIFF:\n${compact(unstagedDiff) || '(empty)'}`
    );
  }

  const diffBody = sections.join('\n\n');
  const trimmed = diffBody.slice(0, diffMaxChars);
  if (trimmed.length < diffBody.length) {
    log(output, debug, `Trimmed ${focusLabel} diff payload for ${cwd}`);
  }

  return {
    text: trimmed,
    hasStagedChanges
  };
}

async function runGit(
  args: string[],
  cwd: string,
  output: vscode.OutputChannel | undefined,
  debug: boolean
): Promise<string> {
  log(output, debug, `Running git ${args.join(' ')}`);

  try {
    const { stdout, stderr } = await execFileAsync('git', args, { cwd, maxBuffer: 1024 * 1024 * 8 });
    if (stderr.trim()) {
      log(output, debug, `git reported stderr for ${cwd}`);
    }
    return stdout.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args.join(' ')} failed: ${message}`);
  }
}

function buildPrompt(gitContext: GitContext): string {
  const changeScopeInstruction = gitContext.hasStagedChanges
    ? 'Focus on the staged changes. Use unstaged or untracked context only when it helps disambiguate intent.'
    : 'Focus on the current working tree changes, including untracked files when relevant.';

  return [
    'Generate exactly one conventional commit message for the git changes below.',
    'Rules:',
    '- Return only the final commit message.',
    '- Prefer a single-line subject with no body.',
    '- Keep the subject concise and ideally under 72 characters.',
    '- Use imperative mood.',
    '- Choose the most accurate conventional type such as feat, fix, refactor, docs, test, chore, build, ci, perf, or style.',
    `- ${changeScopeInstruction}`,
    '',
    'Git context:',
    gitContext.text
  ].join('\n');
}

function sanitizeCommitMessage(value?: string): string {
  const cleaned = (value ?? '')
    .replace(/<think[\s\S]*?<\/think>/gi, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^commit message\s*:\s*/i, '')
    .replace(/^message\s*:\s*/i, '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '');

  const lines = cleaned
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*]\s+/, '').trim())
    .map((line) => line.replace(/^\d+\.\s+/, '').trim())
    .map((line) => line.replace(/^["'`]+|["'`]+$/g, '').trim());

  if (lines.length === 0) {
    return '';
  }

  const preferredLine =
    lines.find((line) => /^[a-z]+(\([^)]+\))?!?:\s+\S+/i.test(line)) ??
    lines.find((line) => line.includes(':')) ??
    lines[0];

  return preferredLine.trim();
}

function log(output: vscode.OutputChannel | undefined, debug: boolean, message: string): void {
  if (!debug || !output) {
    return;
  }

  output.appendLine(`[debug ${new Date().toISOString()}] ${message}`);
}

async function ensureOllamaModelAvailable(
  apiUrl: string,
  model: string,
  output: vscode.OutputChannel,
  debug: boolean,
  requestTimeoutMs: number
): Promise<void> {
  const cacheKey = `${apiUrl}::${model}`;
  if (verifiedOllamaModels.has(cacheKey)) {
    log(output, debug, `Skipping Ollama model check for cached model "${model}"`);
    return;
  }

  const tagsUrl = buildOllamaTagsUrl(apiUrl);
  log(output, debug, `Checking Ollama model availability at ${tagsUrl}`);

  const response = await requestOllama(tagsUrl, requestTimeoutMs);
  const rawText = await response.text();

  if (!response.ok) {
    throw new Error(`Ollama tags API returned ${response.status}: ${rawText}`);
  }

  const parsed = JSON.parse(rawText) as OllamaTagsResponse;
  const installedModels = (parsed.models ?? [])
    .map((entry) => entry.name ?? entry.model ?? '')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (installedModels.includes(model)) {
    verifiedOllamaModels.add(cacheKey);
    return;
  }

  const available = installedModels.length > 0 ? installedModels.join(', ') : 'none';
  throw new Error(`Configured Ollama model "${model}" is not installed. Installed models: ${available}`);
}

function buildOllamaTagsUrl(apiUrl: string): string {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(apiUrl);
  } catch {
    throw new Error(`Invalid Ollama API URL: ${apiUrl}`);
  }

  parsedUrl.pathname = '/api/tags';
  parsedUrl.search = '';
  parsedUrl.hash = '';
  return parsedUrl.toString();
}

async function requestOllama(input: string, timeoutMs: number, options?: OllamaRequestOptions): Promise<OllamaHttpResponse> {
  let url: URL;

  try {
    url = new URL(input);
  } catch (error) {
    throw new Error(formatOllamaRequestError(input, error));
  }

  const transport = url.protocol === 'https:' ? https : http;

  return await new Promise<OllamaHttpResponse>((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: options?.method ?? 'GET',
        headers: options?.headers
      },
      (response) => {
        const chunks: Buffer[] = [];

        response.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });

        response.on('end', () => {
          const rawText = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: response.statusCode ?? 0,
            statusText: response.statusMessage ?? '',
            ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
            text: async () => rawText
          });
        });
      }
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });

    request.on('error', (error) => {
      reject(new Error(formatOllamaRequestError(input, error, timeoutMs)));
    });

    if (options?.body) {
      request.write(options.body);
    }

    request.end();
  });
}

function formatOllamaRequestError(input: string, error: unknown, timeoutMs?: number): string {
  if (!(error instanceof Error)) {
    return `Failed to reach Ollama at ${input}: ${String(error)}`;
  }

  if (error.message.includes('timed out')) {
    const timeoutText = typeof timeoutMs === 'number' ? ` after ${timeoutMs}ms` : '';
    return `Ollama did not respond in time at ${input}${timeoutText}. The model may still be loading. Increase gitAssistant.requestTimeoutMs or use a smaller/faster model.`;
  }

  const cause = error.cause;
  if (cause && typeof cause === 'object') {
    const details = cause as {
      code?: string;
      errno?: string | number;
      syscall?: string;
      address?: string;
      port?: number;
    };
    const parts = [details.code, details.errno, details.syscall, details.address, details.port?.toString()].filter(Boolean);
    if (parts.length > 0) {
      return `Failed to reach Ollama at ${input}: ${error.message} (${parts.join(', ')}). Check that Ollama is running and gitAssistant.apiUrl is correct.`;
    }
  }

  return `Failed to reach Ollama at ${input}: ${error.message}. Check that Ollama is running and gitAssistant.apiUrl is correct.`;
}

function getGitApi(): GitApi | undefined {
  const extension = vscode.extensions.getExtension<{ getAPI(version: number): GitApi }>('vscode.git');
  return extension?.exports?.getAPI(1);
}

function resolveRepositories(
  git: GitApi,
  scmContext: ScmCommandContext | undefined,
  applyToAllRepositories: boolean
): CommandRepository[] {
  const contextPath = scmContext?._rootUri?.fsPath ?? scmContext?.rootUri?.fsPath;
  if (contextPath) {
    return git.repositories.filter((repository) => repository.rootUri.fsPath === contextPath);
  }

  if (applyToAllRepositories) {
    return git.repositories;
  }

  const activeWorkspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!activeWorkspacePath) {
    return [];
  }

  return git.repositories.filter((repository) => repository.rootUri.fsPath === activeWorkspacePath);
}

async function resolveTargetUri(uri?: vscode.Uri): Promise<vscode.Uri> {
  if (uri?.scheme === 'file') {
    return uri;
  }

  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri?.scheme === 'file') {
    return activeUri;
  }

  throw new Error('No file is selected.');
}

async function toggleExcludeFile(uri: vscode.Uri, output: vscode.OutputChannel): Promise<void> {
  const gitRoot = await getGitRoot(uri.fsPath);
  const relativePath = toRelativeGitPath(gitRoot, uri.fsPath);
  const gitInfoDir = path.join(gitRoot, '.git', 'info');
  const excludePath = path.join(gitInfoDir, 'exclude');

  output.show(true);
  output.appendLine(`[progress] Toggling exclude for ${relativePath}`);

  fs.mkdirSync(gitInfoDir, { recursive: true });
  if (!fs.existsSync(excludePath)) {
    fs.writeFileSync(excludePath, '', 'utf8');
  }

  const content = fs.readFileSync(excludePath, 'utf8');
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.includes(relativePath)) {
    const nextContent = lines.filter((line) => line !== relativePath).join('\n');
    fs.writeFileSync(excludePath, nextContent ? `${nextContent}\n` : '', 'utf8');
    void vscode.window.showInformationMessage(`Removed from .git/info/exclude: ${relativePath}`);
    output.appendLine(`[progress] Removed ${relativePath} from exclude`);
    return;
  }

  const nextContent = content.trim() ? `${content.trim()}\n${relativePath}\n` : `${relativePath}\n`;
  fs.writeFileSync(excludePath, nextContent, 'utf8');
  void vscode.window.showInformationMessage(`Added to .git/info/exclude: ${relativePath}`);
  output.appendLine(`[progress] Added ${relativePath} to exclude`);
}

async function checkoutFileFromBranch(uri: vscode.Uri, output: vscode.OutputChannel): Promise<void> {
  const gitRoot = await getGitRoot(uri.fsPath);
  const relativePath = toRelativeGitPath(gitRoot, uri.fsPath);
  const branches = await getBranches(gitRoot);

  if (branches.length === 0) {
    throw new Error('No branches found in this repository.');
  }

  const selectedBranch = await vscode.window.showQuickPick(branches, {
    title: `Checkout ${path.basename(uri.fsPath)} from Branch`,
    placeHolder: `Select branch to checkout ${path.basename(uri.fsPath)} from`,
    ignoreFocusOut: true
  });

  if (!selectedBranch) {
    output.appendLine(`[progress] Checkout cancelled for ${relativePath}`);
    return;
  }

  output.show(true);
  output.appendLine(`[progress] Validating ${relativePath} in branch ${selectedBranch}`);

  try {
    await runGit(['cat-file', '-e', `${selectedBranch}:${relativePath}`], gitRoot, output, false);
  } catch {
    throw new Error(`File "${relativePath}" does not exist in branch "${selectedBranch}".`);
  }

  const confirmation = await vscode.window.showWarningMessage(
    `Replace "${path.basename(uri.fsPath)}" with the version from branch "${selectedBranch}"? Local changes in this file will be lost.`,
    { modal: true },
    'Checkout File',
    'Cancel'
  );

  if (confirmation !== 'Checkout File') {
    output.appendLine(`[progress] Checkout confirmation cancelled for ${relativePath}`);
    return;
  }

  output.appendLine(`[progress] Checking out ${relativePath} from ${selectedBranch}`);
  await runGit(['checkout', selectedBranch, '--', relativePath], gitRoot, output, false);
  await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');

  if (vscode.window.activeTextEditor?.document.uri.fsPath === uri.fsPath) {
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
  }

  void vscode.window.showInformationMessage(`${path.basename(uri.fsPath)} updated from branch "${selectedBranch}".`);
  output.appendLine(`[progress] Checkout completed for ${relativePath}`);
}

async function getGitRoot(filePath: string): Promise<string> {
  const root = await runGit(['rev-parse', '--show-toplevel'], path.dirname(filePath), undefined, false);
  return root.trim();
}

async function getBranches(gitRoot: string): Promise<string[]> {
  const output = await runGit(
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'],
    gitRoot,
    undefined,
    false
  );

  return Array.from(
    new Set(
      output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !line.endsWith('/HEAD'))
    )
  );
}

function toRelativeGitPath(gitRoot: string, filePath: string): string {
  return path.relative(gitRoot, filePath).replace(/\\/g, '/');
}
