import * as vscode from "vscode";
import { AnalyzerClient, formatError } from "./analyzerClient";

const ignoredDirectory = /(?:^|[\\/])(?:\.git|node_modules|out|dist|build|target)(?:[\\/]|$)/i;

export class WorkspaceIndexer implements vscode.Disposable {
  private readonly indexed = new Set<string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly watcher: vscode.FileSystemWatcher;
  private disposed = false;

  constructor(
    private readonly client: AnalyzerClient,
    private readonly output: vscode.OutputChannel,
    private readonly refresh: () => void,
  ) {
    this.watcher = vscode.workspace.createFileSystemWatcher("**/*.wl");
    this.watcher.onDidCreate((uri) => this.schedule(uri));
    this.watcher.onDidChange((uri) => this.schedule(uri));
    this.watcher.onDidDelete((uri) => {
      void this.remove(uri);
    });
  }

  async start(): Promise<void> {
    const files = await vscode.workspace.findFiles(
      "**/*.wl",
      "**/{.git,node_modules,out,dist,build,target}/**",
      10000,
    );

    for (const uri of files) {
      if (this.disposed) {
        return;
      }
      await this.load(uri);
    }
    this.refresh();
    this.output.appendLine(`workspace highlighting index ready (${this.indexed.size} files)`);
  }

  async restoreAfterClose(document: vscode.TextDocument): Promise<void> {
    const key = this.key(document.uri);
    if (!this.indexed.has(key)) {
      await this.client.close(document);
      this.refresh();
      return;
    }

    try {
      const text = new TextDecoder("utf-8").decode(
        await vscode.workspace.fs.readFile(document.uri),
      );
      await this.client.synchronizeText(document.uri.fsPath, text);
    } catch {
      this.indexed.delete(key);
      await this.client.close(document);
    }
    this.refresh();
  }

  dispose(): void {
    this.disposed = true;
    this.watcher.dispose();
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  private schedule(uri: vscode.Uri): void {
    if (!this.shouldIndex(uri)) {
      return;
    }

    const key = this.key(uri);
    const previous = this.timers.get(key);
    if (previous) {
      clearTimeout(previous);
    }
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      void this.load(uri)
        .then(() => this.refresh())
        .catch((error) => {
          this.output.appendLine(`failed to index ${uri.fsPath}: ${formatError(error)}`);
        });
    }, 300));
  }

  private async load(uri: vscode.Uri): Promise<void> {
    if (!this.shouldIndex(uri)) {
      return;
    }

    const open = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === uri.toString(),
    );
    const text = open
      ? open.getText()
      : new TextDecoder("utf-8").decode(await vscode.workspace.fs.readFile(uri));
    await this.client.synchronizeText(uri.fsPath, text);
    this.indexed.add(this.key(uri));
  }

  private async remove(uri: vscode.Uri): Promise<void> {
    const key = this.key(uri);
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
    this.indexed.delete(key);
    await this.client.closePath(uri.fsPath);
    this.refresh();
  }

  private shouldIndex(uri: vscode.Uri): boolean {
    return uri.scheme === "file"
      && uri.fsPath.toLowerCase().endsWith(".wl")
      && !ignoredDirectory.test(uri.fsPath);
  }

  private key(uri: vscode.Uri): string {
    const path = uri.fsPath;
    return process.platform === "win32" ? path.toLowerCase() : path;
  }
}
