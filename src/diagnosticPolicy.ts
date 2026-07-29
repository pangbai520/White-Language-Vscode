import * as vscode from "vscode";
import { HandleDiagnosticsSignature } from "vscode-languageclient";

type DiagnosticMode = "workspace" | "openFiles" | "visitedFiles";

export class DiagnosticPolicy implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly visited = new Set<string>();
  private readonly cached = new Map<string, vscode.Diagnostic[]>();
  private readonly publishers = new Map<string, HandleDiagnosticsSignature>();
  private readonly closing = new Set<string>();
  private readonly watcher =
    vscode.workspace.createFileSystemWatcher("**/*.wl");
  private mode = readMode();

  constructor() {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const uri = tabUri(tab);
        if (uri) {
          this.visited.add(uri.toString());
        }
      }
    }

    this.subscriptions.push(
      vscode.window.tabGroups.onDidChangeTabs((event) => {
        for (const tab of event.opened) {
          const uri = tabUri(tab);
          if (uri) {
            this.visited.add(uri.toString());
          }
        }
        this.publishAll();
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && isWhiteLanguageDocument(editor.document)) {
          this.visited.add(editor.document.uri.toString());
          this.publish(editor.document.uri);
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("whitelanguage.diagnostics.mode")) {
          this.mode = readMode();
          this.publishAll();
        }
      }),
      this.watcher.onDidDelete((uri) => this.forget(uri)),
    );
  }

  handle(
    uri: vscode.Uri,
    diagnostics: vscode.Diagnostic[],
    next: HandleDiagnosticsSignature,
  ): void {
    const key = uri.toString();
    this.publishers.set(key, next);
    const documentClosed = this.closing.delete(key);

    if (
      documentClosed &&
      diagnostics.length === 0 &&
      this.mode !== "openFiles"
    ) {
      return;
    }

    this.cached.set(key, diagnostics);
    next(uri, this.shouldPublish(uri) ? diagnostics : []);
  }

  beforeDocumentClose(uri: vscode.Uri): void {
    if (this.mode !== "openFiles") {
      this.closing.add(uri.toString());
    }
  }

  reset(): void {
    for (const [key, publish] of this.publishers) {
      publish(vscode.Uri.parse(key), []);
    }
    this.cached.clear();
    this.publishers.clear();
    this.closing.clear();
  }

  dispose(): void {
    this.reset();
    this.watcher.dispose();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
    this.visited.clear();
  }

  private forget(uri: vscode.Uri): void {
    const key = uri.toString();
    this.publishers.get(key)?.(uri, []);
    this.publishers.delete(key);
    this.cached.delete(key);
    this.closing.delete(key);
    this.visited.delete(key);
  }

  private publish(uri: vscode.Uri): void {
    const key = uri.toString();
    const diagnostics = this.cached.get(key);
    if (!diagnostics) {
      return;
    }
    this.publishers.get(key)?.(uri, this.shouldPublish(uri) ? diagnostics : []);
  }

  private publishAll(): void {
    for (const key of this.cached.keys()) {
      this.publish(vscode.Uri.parse(key));
    }
  }

  private shouldPublish(uri: vscode.Uri): boolean {
    if (this.mode === "workspace") {
      return true;
    }
    if (this.mode === "visitedFiles") {
      return this.visited.has(uri.toString());
    }
    return isOpenInEditor(uri);
  }
}

function readMode(): DiagnosticMode {
  return vscode.workspace
    .getConfiguration("whitelanguage")
    .get<DiagnosticMode>("diagnostics.mode", "openFiles");
}

function isWhiteLanguageDocument(document: vscode.TextDocument): boolean {
  return document.languageId === "whitelang" && document.uri.scheme === "file";
}

function isOpenInEditor(uri: vscode.Uri): boolean {
  const key = uri.toString();
  return vscode.window.tabGroups.all.some((group) =>
    group.tabs.some((tab) => tabUri(tab)?.toString() === key),
  );
}

function tabUri(tab: vscode.Tab): vscode.Uri | undefined {
  return tab.input instanceof vscode.TabInputText &&
    tab.input.uri.scheme === "file" &&
    tab.input.uri.fsPath.toLowerCase().endsWith(".wl")
    ? tab.input.uri
    : undefined;
}
