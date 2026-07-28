import { stat } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";
import { AnalyzerClient, findAnalyzer, formatError } from "./analyzerClient";
import { InitializeResult, protocolVersion } from "./protocol";
import { registerRunner } from "./runner";
import { SemanticTokenCache } from "./semanticTokenCache";
import { WhiteSemanticTokensProvider } from "./semanticTokens";
import { WorkspaceIndexer } from "./workspaceIndexer";

let analyzer: AnalyzerClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("White Language");
  context.subscriptions.push(output, registerRunner(context, output));

  const executable = await findAnalyzer();
  if (!executable) {
    const action = await vscode.window.showWarningMessage(
      "White Language semantic highlighting is unavailable because wlls was not found.",
      "Open Settings",
    );
    if (action === "Open Settings") {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "whitelanguage.server.path",
      );
    }
    return;
  }

  const trace = vscode.workspace
    .getConfiguration("whitelanguage")
    .get<boolean>("server.trace", false);
  analyzer = new AnalyzerClient(executable, output, trace);
  context.subscriptions.push(analyzer);

  let initialized: InitializeResult;
  try {
    initialized = await analyzer.start();
  } catch (error) {
    output.appendLine(`failed to start ${executable}: ${formatError(error)}`);
    void vscode.window.showErrorMessage(
      `White Language analyzer failed to start: ${formatError(error)}`,
    );
    return;
  }

  if (
    initialized.protocol !== protocolVersion
    || !initialized.capabilities.semanticTokens?.full
  ) {
    void vscode.window.showErrorMessage(
      "The installed wlls does not support the semantic token protocol required by this extension.",
    );
    await analyzer.stop();
    analyzer = undefined;
    return;
  }

  const capability = initialized.capabilities.semanticTokens;
  const legend = new vscode.SemanticTokensLegend(
    capability.tokenTypes,
    capability.tokenModifiers,
  );
  const serverInfo = await stat(executable);
  const cacheNamespace = JSON.stringify({
    schema: 1,
    extensionVersion: context.extension.packageJSON.version,
    serverSize: serverInfo.size,
    serverModified: serverInfo.mtimeMs,
    tokenTypes: capability.tokenTypes,
    tokenModifiers: capability.tokenModifiers,
  });
  const cache = new SemanticTokenCache(
    join(context.globalStorageUri.fsPath, "semantic-tokens"),
    cacheNamespace,
  );
  const provider = new WhiteSemanticTokensProvider(
    analyzer,
    legend,
    capability,
    output,
    cache,
  );
  const refreshTimers = new Map<string, NodeJS.Timeout>();
  const workspaceIndexer = new WorkspaceIndexer(
    analyzer,
    output,
    () => provider.refresh(),
  );

  const synchronizeAndRefresh = async (document: vscode.TextDocument): Promise<void> => {
    if (document.languageId !== "whitelang" || document.uri.scheme !== "file") {
      return;
    }
    try {
      await analyzer?.synchronize(document);
      provider.refresh();
    } catch (error) {
      output.appendLine(
        `failed to synchronize ${document.uri.fsPath}: ${formatError(error)}`,
      );
    }
  };

  context.subscriptions.push(
    provider,
    workspaceIndexer,
    vscode.languages.registerDocumentSemanticTokensProvider(
      { language: "whitelang", scheme: "file" },
      provider,
      legend,
    ),
    vscode.workspace.onDidOpenTextDocument((document) => {
      void synchronizeAndRefresh(document);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.languageId !== "whitelang" || event.document.uri.scheme !== "file") {
        return;
      }

      const key = event.document.uri.toString();
      const previous = refreshTimers.get(key);
      if (previous) {
        clearTimeout(previous);
      }
      refreshTimers.set(key, setTimeout(() => {
        refreshTimers.delete(key);
        void synchronizeAndRefresh(event.document);
      }, 300));
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.languageId === "whitelang") {
        const key = document.uri.toString();
        const timer = refreshTimers.get(key);
        if (timer) {
          clearTimeout(timer);
          refreshTimers.delete(key);
        }
        void workspaceIndexer.restoreAfterClose(document).catch((error) => {
          output.appendLine(
            `failed to close ${document.uri.fsPath}: ${formatError(error)}`,
          );
        });
      }
    }),
    vscode.window.onDidChangeActiveColorTheme(() => {
      provider.refresh();
    }),
    {
      dispose: () => {
        for (const timer of refreshTimers.values()) {
          clearTimeout(timer);
        }
        refreshTimers.clear();
      },
    },
  );

  output.appendLine(`semantic highlighting ready (${executable})`);

  for (const document of vscode.workspace.textDocuments) {
    if (document.languageId === "whitelang" && document.uri.scheme === "file") {
      try {
        await analyzer.synchronize(document);
      } catch (error) {
        output.appendLine(
          `failed to synchronize ${document.uri.fsPath}: ${formatError(error)}`,
        );
      }
    }
  }
  provider.refresh();
  void workspaceIndexer.start().catch((error) => {
    output.appendLine(`workspace highlighting index failed: ${formatError(error)}`);
  });
}

export async function deactivate(): Promise<void> {
  await analyzer?.stop();
  analyzer = undefined;
}
