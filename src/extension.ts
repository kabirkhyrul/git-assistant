import * as vscode from "vscode";
import { generateCommitMessages } from "./commit";
import type { ScmCommandContext } from "./commit";

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

  context.subscriptions.push(disposable, output);
}

export function deactivate(): void {}
