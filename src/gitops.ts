import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function log(output: vscode.OutputChannel, debug: boolean, message: string): void {
  if (debug) {
    output.appendLine(`[debug ${new Date().toISOString()}] ${message}`);
  }
}

async function runGit(
  args: string[],
  cwd: string,
  output: vscode.OutputChannel,
  debug: boolean,
): Promise<string> {
  log(output, debug, `Running git ${args.join(" ")} in ${cwd}`);
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

function getRepoRoot(uri: vscode.Uri): string | undefined {
  const extension = vscode.extensions.getExtension<{
    getAPI(version: number): { repositories: { rootUri: vscode.Uri }[] };
  }>("vscode.git");
  const git = extension?.exports?.getAPI(1);
  if (!git) {
    return undefined;
  }
  const repo = git.repositories.find((r) =>
    uri.fsPath.startsWith(r.rootUri.fsPath),
  );
  return repo?.rootUri.fsPath;
}

export async function toggleExcludeFile(
  uri: vscode.Uri,
  output: vscode.OutputChannel,
): Promise<void> {
  const debug = vscode.workspace.getConfiguration("gitAssistant").get<boolean>("debug", true);

  const repoRoot = getRepoRoot(uri);
  if (!repoRoot) {
    void vscode.window.showErrorMessage("No git repository found for this file.");
    return;
  }

  const relativePath = path.relative(repoRoot, uri.fsPath);
  const excludePath = path.join(repoRoot, ".git", "info", "exclude");
  log(output, debug, `exclude file path: ${excludePath}`);

  let content = "";
  if (fs.existsSync(excludePath)) {
    content = fs.readFileSync(excludePath, "utf8");
  }

  const lines = content.split("\n");
  const idx = lines.findIndex((l) => l.trim() === relativePath);

  if (idx !== -1) {
    lines.splice(idx, 1);
    fs.writeFileSync(excludePath, lines.join("\n"), "utf8");
    log(output, debug, `Removed ${relativePath} from exclude`);
    void vscode.window.showInformationMessage(`Un-excluded: ${relativePath}`);
  } else {
    fs.appendFileSync(excludePath, `\n${relativePath}`, "utf8");
    log(output, debug, `Appended ${relativePath} to exclude`);

    // If the file is tracked, untrack it
    const lsFiles = await runGit(
      ["ls-files", "--error-unmatch", relativePath],
      repoRoot,
      output,
      debug,
    ).catch(() => "");

    if (lsFiles) {
      await runGit(["rm", "--cached", relativePath], repoRoot, output, debug);
    }

    void vscode.window.showInformationMessage(`Excluded: ${relativePath}`);
  }
}

export async function checkoutFileFromBranch(
  uri: vscode.Uri,
  output: vscode.OutputChannel,
): Promise<void> {
  const debug = vscode.workspace.getConfiguration("gitAssistant").get<boolean>("debug", true);

  const repoRoot = getRepoRoot(uri);
  if (!repoRoot) {
    void vscode.window.showErrorMessage("No git repository found for this file.");
    return;
  }

  const branchList = await runGit(["branch", "-a"], repoRoot, output, debug);
  const branches = branchList
    .split("\n")
    .map((b) => b.replace(/^\*?\s+/, "").trim())
    .filter(Boolean);

  const branch = await vscode.window.showQuickPick(branches, {
    placeHolder: "Select branch to restore file from",
  });
  if (!branch) {
    return;
  }

  const relativePath = path.relative(repoRoot, uri.fsPath);
  await runGit(["restore", "--source", branch, "--", relativePath], repoRoot, output, debug);

  void vscode.window.showInformationMessage(`Restored ${relativePath} from ${branch}`);
}
