import * as vscode from "vscode";
import { generateCommitMessages } from "./commit";
import type { ScmCommandContext } from "./commit";
import { toggleExcludeFile, checkoutFileFromBranch } from "./gitops";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Git Kit");

  const disposable = vscode.commands.registerCommand(
    "gitKit.generateCommitMessage",
    async (scmContext?: ScmCommandContext) => {
      output.show(true);
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Git Kit: Generating commit message…",
          cancellable: false,
        },
        async () => {
          try {
            await generateCommitMessages(output, scmContext);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            output.appendLine(`[error] ${message}`);
            void vscode.window.showErrorMessage(`Git Kit failed: ${message}`);
          }
        },
      );
    },
  );

  const excludeDisposable = vscode.commands.registerCommand(
    "gitKit.toggleExcludeFile",
    async (uri: vscode.Uri) => {
      output.show(true);
      try {
        await toggleExcludeFile(uri, output);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[error] ${message}`);
        void vscode.window.showErrorMessage(`Git Kit failed: ${message}`);
      }
    },
  );

  const checkoutDisposable = vscode.commands.registerCommand(
    "gitKit.checkoutFileFromBranch",
    async (uri: vscode.Uri) => {
      output.show(true);
      try {
        await checkoutFileFromBranch(uri, output);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[error] ${message}`);
        void vscode.window.showErrorMessage(`Git Kit failed: ${message}`);
      }
    },
  );

  context.subscriptions.push(disposable, excludeDisposable, checkoutDisposable, output);
}

export function deactivate(): void {}
