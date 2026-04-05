import * as vscode from "vscode";
import { generateCommitMessages } from "./commit";
import type { ScmCommandContext } from "./commit";
import { toggleExcludeFile, checkoutFileFromBranch } from "./gitops";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Git Assistant");

  const disposable = vscode.commands.registerCommand(
    "gitAssistant.generateCommitMessage",
    async (scmContext?: ScmCommandContext) => {
      output.show(true);
      try {
        await generateCommitMessages(output, scmContext);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[error] ${message}`);
        void vscode.window.showErrorMessage(`Git Assistant failed: ${message}`);
      }
    },
  );

  const excludeDisposable = vscode.commands.registerCommand(
    "gitAssistant.toggleExcludeFile",
    async (uri: vscode.Uri) => {
      output.show(true);
      try {
        await toggleExcludeFile(uri, output);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[error] ${message}`);
        void vscode.window.showErrorMessage(`Git Assistant failed: ${message}`);
      }
    },
  );

  const checkoutDisposable = vscode.commands.registerCommand(
    "gitAssistant.checkoutFileFromBranch",
    async (uri: vscode.Uri) => {
      output.show(true);
      try {
        await checkoutFileFromBranch(uri, output);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[error] ${message}`);
        void vscode.window.showErrorMessage(`Git Assistant failed: ${message}`);
      }
    },
  );

  context.subscriptions.push(disposable, excludeDisposable, checkoutDisposable, output);
}

export function deactivate(): void {}
