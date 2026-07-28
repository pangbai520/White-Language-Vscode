import * as vscode from "vscode";
import { AnalyzerClient, formatError } from "./analyzerClient";
import { AnalyzerDiagnostic } from "./protocol";

type DiagnosticMode = "workspace" | "openFiles" | "visitedFiles";

const diagnosticExclude = "**/{.git,node_modules,out,dist,build,target}/**";

export class DiagnosticManager implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection("whitelanguage");
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly generations = new Map<string, number>();
  private readonly watcher = vscode.workspace.createFileSystemWatcher("**/*.wl");
  private mode = readDiagnosticMode();
  private disposed = false;

  constructor(
    private readonly client: AnalyzerClient,
    private readonly output: vscode.OutputChannel,
  ) {
    this.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument((document) => {
        if (isWhiteLanguageDocument(document)) {
          void this.update(document);
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (isWhiteLanguageDocument(event.document)) {
          this.schedule(event.document);
        }
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (isWhiteLanguageDocument(document)) {
          this.cancel(document.uri);
          if (this.mode === "openFiles") {
            this.collection.delete(document.uri);
          }
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("whitelanguage.diagnostics.mode")) {
          void this.changeMode();
        }
      }),
      this.watcher.onDidCreate((uri) => this.scheduleFile(uri)),
      this.watcher.onDidChange((uri) => this.scheduleFile(uri)),
      this.watcher.onDidDelete((uri) => {
        this.cancel(uri);
        this.collection.delete(uri);
      }),
      this.client.onDidStop(() => {
        this.collection.clear();
      }),
    );
  }

  start(): void {
    if (this.mode === "workspace") {
      void this.scanWorkspace();
      return;
    }

    for (const document of vscode.workspace.textDocuments) {
      if (isWhiteLanguageDocument(document)) {
        void this.update(document);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.watcher.dispose();
    this.collection.dispose();
  }

  private schedule(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const previous = this.timers.get(key);
    if (previous) {
      clearTimeout(previous);
    }

    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      void this.update(document);
    }, 300));
  }

  private scheduleFile(uri: vscode.Uri): void {
    if (this.mode !== "workspace" || !isWhiteLanguageUri(uri)) {
      return;
    }

    const key = uri.toString();
    const previous = this.timers.get(key);
    if (previous) {
      clearTimeout(previous);
    }
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      void this.updateFile(uri);
    }, 300));
  }

  private async update(document: vscode.TextDocument): Promise<void> {
    const key = document.uri.toString();
    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);

    try {
      await this.client.synchronize(document);
      const result = await this.client.request<AnalyzerDiagnostic[]>(
        "textDocument/diagnostics",
        { path: document.uri.fsPath },
      );
      if (
        this.disposed
        || this.generations.get(key) !== generation
        || (document.isClosed && this.mode === "openFiles")
      ) {
        return;
      }

      this.collection.set(
        document.uri,
        result.map((diagnostic) => convertDiagnostic(diagnostic, document)),
      );
    } catch (error) {
      if (
        this.generations.get(key) === generation
        && (!document.isClosed || this.mode !== "openFiles")
      ) {
        this.output.appendLine(
          `diagnostics failed for ${document.uri.fsPath}: ${formatError(error)}`,
        );
      }
    }
  }

  private cancel(uri: vscode.Uri): void {
    const key = uri.toString();
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
  }

  private async updateFile(uri: vscode.Uri): Promise<void> {
    if (this.disposed || this.mode !== "workspace") {
      return;
    }

    const open = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === uri.toString(),
    );
    if (open) {
      await this.update(open);
      return;
    }

    const key = uri.toString();
    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);
    try {
      const text = new TextDecoder("utf-8").decode(
        await vscode.workspace.fs.readFile(uri),
      );
      await this.client.synchronizeText(uri.fsPath, text);
      const result = await this.client.request<AnalyzerDiagnostic[]>(
        "textDocument/diagnostics",
        { path: uri.fsPath },
      );
      if (
        this.disposed
        || this.mode !== "workspace"
        || this.generations.get(key) !== generation
      ) {
        return;
      }
      this.collection.set(
        uri,
        result.map((diagnostic) => convertDiagnostic(diagnostic)),
      );
    } catch (error) {
      if (this.generations.get(key) === generation) {
        this.output.appendLine(
          `diagnostics failed for ${uri.fsPath}: ${formatError(error)}`,
        );
      }
    }
  }

  private async scanWorkspace(): Promise<void> {
    const files = await vscode.workspace.findFiles("**/*.wl", diagnosticExclude);
    let scanned = 0;
    for (const uri of files) {
      if (this.disposed || this.mode !== "workspace") {
        return;
      }
      await this.updateFile(uri);
      scanned += 1;
    }
    this.output.appendLine(`workspace diagnostics ready (${scanned} files)`);
  }

  private async changeMode(): Promise<void> {
    this.mode = readDiagnosticMode();
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.generations.clear();
    this.collection.clear();
    this.start();
  }
}

function convertDiagnostic(
  diagnostic: AnalyzerDiagnostic,
  document?: vscode.TextDocument,
): vscode.Diagnostic {
  const rawStart = new vscode.Position(
    validCoordinate(diagnostic.range?.start?.line),
    validCoordinate(diagnostic.range?.start?.character),
  );
  const rawEnd = new vscode.Position(
    validCoordinate(diagnostic.range?.end?.line),
    validCoordinate(diagnostic.range?.end?.character),
  );
  const start = document ? document.validatePosition(rawStart) : rawStart;
  const end = document ? document.validatePosition(rawEnd) : rawEnd;
  const range = end.isBefore(start)
    ? new vscode.Range(start, start)
    : new vscode.Range(start, end);
  const converted = new vscode.Diagnostic(
    range,
    diagnostic.message || "White Language syntax error.",
    diagnosticSeverity(diagnostic.severity),
  );
  converted.source = "wlls";
  if (diagnostic.code) {
    converted.code = diagnostic.code;
  }
  return converted;
}

function diagnosticSeverity(value: string): vscode.DiagnosticSeverity {
  switch (value?.toLowerCase()) {
    case "warning":
      return vscode.DiagnosticSeverity.Warning;
    case "information":
    case "info":
      return vscode.DiagnosticSeverity.Information;
    case "hint":
      return vscode.DiagnosticSeverity.Hint;
    default:
      return vscode.DiagnosticSeverity.Error;
  }
}

function validCoordinate(value: number | undefined): number {
  return Number.isInteger(value) && value !== undefined && value >= 0 ? value : 0;
}

function isWhiteLanguageDocument(document: vscode.TextDocument): boolean {
  return document.languageId === "whitelang" && document.uri.scheme === "file";
}

function isWhiteLanguageUri(uri: vscode.Uri): boolean {
  return uri.scheme === "file" && uri.fsPath.toLowerCase().endsWith(".wl");
}

function readDiagnosticMode(): DiagnosticMode {
  return vscode.workspace
    .getConfiguration("whitelanguage")
    .get<DiagnosticMode>("diagnostics.mode", "openFiles");
}
