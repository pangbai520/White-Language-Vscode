import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import * as vscode from "vscode";
import {
  AnalyzerResponse,
  encodeMessage,
  InitializeResult,
  MessageReader,
  protocolVersion,
  ProtocolError,
} from "./protocol";

interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  cancellation?: vscode.Disposable;
}

export class AnalyzerClient implements vscode.Disposable {
  private process: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly documentVersions = new Map<string, number>();
  private readonly documentTexts = new Map<string, string>();
  private readonly documentSyncs = new Map<string, Promise<void>>();
  private stopping = false;

  constructor(
    private readonly executable: string,
    private readonly output: vscode.OutputChannel,
    private readonly trace: boolean,
  ) {}

  async start(): Promise<InitializeResult> {
    this.process = spawn(this.executable, ["--stdio"], {
      windowsHide: true,
      stdio: "pipe",
    });

    const reader = new MessageReader();
    reader.on("message", (message) => this.handleResponse(message));
    reader.on("error", (error) => this.failAll(error));
    this.process.stdout.on("data", (chunk: Buffer) => reader.push(chunk));
    this.process.stderr.on("data", (chunk: Buffer) => {
      this.output.append(chunk.toString("utf8"));
    });
    this.process.on("error", (error) => this.failAll(error));
    this.process.on("exit", (code, signal) => {
      const detail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      if (!this.stopping) {
        this.output.appendLine(`wlls stopped unexpectedly (${detail}).`);
      }
      this.failAll(new Error(`wlls stopped (${detail})`));
      this.process = undefined;
      this.documentVersions.clear();
      this.documentTexts.clear();
      this.documentSyncs.clear();
    });

    return this.request<InitializeResult>("initialize", {});
  }

  async synchronize(document: vscode.TextDocument): Promise<void> {
    await this.synchronizeText(document.uri.fsPath, document.getText());
  }

  async synchronizeText(path: string, text: string): Promise<void> {
    const previous = this.documentSyncs.get(path) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.documentTexts.get(path) === text) {
          return;
        }

        const knownVersion = this.documentVersions.get(path);
        const method = knownVersion === undefined
          ? "textDocument/open"
          : "textDocument/change";
        const version = (knownVersion ?? 0) + 1;
        await this.request(method, { path, version, text });
        this.documentVersions.set(path, version);
        this.documentTexts.set(path, text);
      });

    this.documentSyncs.set(path, current);
    try {
      await current;
    } finally {
      if (this.documentSyncs.get(path) === current) {
        this.documentSyncs.delete(path);
      }
    }
  }

  async close(document: vscode.TextDocument): Promise<void> {
    await this.closePath(document.uri.fsPath);
  }

  async closePath(path: string): Promise<void> {
    await this.documentSyncs.get(path)?.catch(() => undefined);
    if (!this.documentVersions.delete(path) || !this.process) {
      return;
    }
    this.documentTexts.delete(path);

    try {
      await this.request("textDocument/close", { path });
    } catch (error) {
      this.output.appendLine(`failed to close ${path}: ${formatError(error)}`);
    }
  }

  request<T>(
    method: string,
    params: Record<string, unknown>,
    cancellationToken?: vscode.CancellationToken,
  ): Promise<T> {
    const child = this.process;
    if (!child || child.stdin.destroyed) {
      return Promise.reject(new Error("wlls is not running"));
    }

    const id = this.nextId++;
    const request = {
      protocol: protocolVersion,
      id,
      method,
      ...params,
    };

    if (this.trace) {
      this.output.appendLine(`--> ${JSON.stringify(request)}`);
    }

    return new Promise<T>((resolveRequest, rejectRequest) => {
      const pending: PendingRequest = {
        resolve: (value) => resolveRequest(value as T),
        reject: rejectRequest,
      };

      if (cancellationToken) {
        pending.cancellation = cancellationToken.onCancellationRequested(() => {
          if (this.pending.delete(id)) {
            rejectRequest(new vscode.CancellationError());
          }
        });
      }

      this.pending.set(id, pending);
      child.stdin.write(encodeMessage(request), (error) => {
        if (!error) {
          return;
        }
        const current = this.pending.get(id);
        if (current) {
          this.pending.delete(id);
          current.cancellation?.dispose();
          current.reject(error);
        }
      });
    });
  }

  async stop(): Promise<void> {
    const child = this.process;
    if (!child) {
      return;
    }

    this.stopping = true;
    try {
      await this.request("shutdown", {});
    } catch {
      // the process may already be gone
    }
    child.stdin.end();

    await new Promise<void>((resolveExit) => {
      if (child.exitCode !== null) {
        resolveExit();
        return;
      }

      const timer = setTimeout(() => {
        child.kill();
        resolveExit();
      }, 1500);
      child.once("exit", () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
    this.process = undefined;
  }

  dispose(): void {
    void this.stop();
  }

  private handleResponse(raw: unknown): void {
    const response = raw as AnalyzerResponse<unknown>;
    if (this.trace) {
      this.output.appendLine(`<-- ${JSON.stringify(response)}`);
    }

    if (!Number.isInteger(response?.id)) {
      this.output.appendLine("ignored wlls response without a request id");
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }

    this.pending.delete(response.id);
    pending.cancellation?.dispose();

    if (response.protocol !== protocolVersion) {
      pending.reject(new ProtocolError(
        "unsupportedProtocol",
        `wlls responded with protocol ${response.protocol}`,
      ));
    } else if (response.error) {
      pending.reject(new ProtocolError(response.error.code, response.error.message));
    } else {
      pending.resolve(response.result);
    }
  }

  private failAll(error: unknown): void {
    for (const pending of this.pending.values()) {
      pending.cancellation?.dispose();
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export async function findAnalyzer(): Promise<string | undefined> {
  const configured = vscode.workspace
    .getConfiguration("whitelanguage")
    .get<string>("server.path", "")
    .trim();
  const executableName = process.platform === "win32" ? "wlls.exe" : "wlls";
  const candidates: string[] = [];

  if (configured) {
    candidates.push(isAbsolute(configured) ? configured : resolve(configured));
  }

  const wlPath = process.env.WL_PATH;
  if (wlPath) {
    candidates.push(join(wlPath, "bin", executableName));
  }

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try the next known location
    }
  }

  return undefined;
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
