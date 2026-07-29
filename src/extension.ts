import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  State,
  Trace,
} from "vscode-languageclient/node";
import { DiagnosticPolicy } from "./diagnosticPolicy";
import { findServer, formatError } from "./server";
import { registerRunner } from "./runner";

const semanticTokenDelayMs = 75;
const documentSymbolDelayMs = 100;

let client: LanguageClient | undefined;

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const output = vscode.window.createOutputChannel("White Language", {
    log: true,
  });
  context.subscriptions.push(output, registerRunner(context, output));

  const executable = await findServer();
  if (!executable) {
    const action = await vscode.window.showWarningMessage(
      "White Language language features are unavailable because wlls was not found.",
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

  const diagnostics = new DiagnosticPolicy();
  const serverOptions: ServerOptions = {
    command: executable,
    args: ["--stdio"],
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "whitelang" }],
    outputChannel: output,
    traceOutputChannel: output,
    middleware: {
      handleDiagnostics: (uri, items, next) => {
        diagnostics.handle(uri, items, next);
      },
      didClose: async (document, next) => {
        diagnostics.beforeDocumentClose(document.uri);
        await next(document);
      },
      provideDocumentSemanticTokens: async (document, token, next) => {
        if (
          !(await waitForVisibleDocument(document, token, semanticTokenDelayMs))
        ) {
          return null;
        }
        return next(document, token);
      },
      provideDocumentSymbols: async (document, token, next) => {
        if (
          !(await waitForVisibleDocument(
            document,
            token,
            documentSymbolDelayMs,
          ))
        ) {
          return null;
        }
        return next(document, token);
      },
    },
  };

  const languageClient = new LanguageClient(
    "whitelanguage",
    "White Language",
    serverOptions,
    clientOptions,
  );
  client = languageClient;
  context.subscriptions.push(
    diagnostics,
    languageClient.onDidChangeState((event) => {
      if (event.newState === State.Stopped) {
        diagnostics.reset();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("whitelanguage.server.trace")) {
        void updateTrace(languageClient).catch((error) => {
          output.appendLine(
            `failed to update protocol tracing: ${formatError(error)}`,
          );
        });
      }
      if (event.affectsConfiguration("whitelanguage.server.path")) {
        void vscode.window
          .showInformationMessage(
            "Reload VS Code to use the new White Language language server path.",
            "Reload",
          )
          .then((action) => {
            if (action === "Reload") {
              void vscode.commands.executeCommand(
                "workbench.action.reloadWindow",
              );
            }
          });
      }
    }),
  );

  try {
    await languageClient.start();
    await updateTrace(languageClient);
  } catch (error) {
    output.appendLine(`failed to start ${executable}: ${formatError(error)}`);
    void vscode.window.showErrorMessage(
      `White Language language server failed to start: ${formatError(error)}`,
    );
    await languageClient.stop().catch(() => undefined);
    if (client === languageClient) {
      client = undefined;
    }
    return;
  }

  output.appendLine(`White Language language server ready (${executable})`);
}

export async function deactivate(): Promise<void> {
  const running = client;
  client = undefined;
  await running?.stop();
}

async function updateTrace(languageClient: LanguageClient): Promise<void> {
  const enabled = vscode.workspace
    .getConfiguration("whitelanguage")
    .get<boolean>("server.trace", false);
  await languageClient.setTrace(enabled ? Trace.Verbose : Trace.Off);
}

function waitForVisibleDocument(
  document: vscode.TextDocument,
  token: vscode.CancellationToken,
  delayMs: number,
): Promise<boolean> {
  if (token.isCancellationRequested) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let cancellation: vscode.Disposable | undefined;
    const finish = (value: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      cancellation?.dispose();
      resolve(value);
    };
    timer = setTimeout(() => {
      finish(
        vscode.window.visibleTextEditors.some(
          (editor) =>
            editor.document.uri.toString() === document.uri.toString(),
        ),
      );
    }, delayMs);
    cancellation = token.onCancellationRequested(() => finish(false));
    if (token.isCancellationRequested) {
      finish(false);
    }
  });
}
