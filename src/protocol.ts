import { EventEmitter } from "node:events";

export const protocolVersion = 1;

export interface AnalyzerError {
  code: string;
  message: string;
}

export interface AnalyzerResponse<T> {
  protocol: number;
  id: number;
  result?: T;
  error?: AnalyzerError;
}

export interface SemanticTokensCapability {
  full: boolean;
  delta: boolean;
  tokenTypes: string[];
  tokenModifiers: string[];
}

export interface AnalyzerCapabilities {
  documentSync: boolean;
  diagnostics: boolean;
  documentSymbols: boolean;
  definition: boolean;
  semanticTokens: SemanticTokensCapability;
}

export interface InitializeResult {
  name: string;
  protocol: number;
  capabilities: AnalyzerCapabilities;
}

export interface AnalyzerSemanticToken {
  line: number;
  character: number;
  length: number;
  type: string;
  modifiers: string[];
}

export class ProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "ascii");
  return Buffer.concat([header, body]);
}

export class MessageReader extends EventEmitter {
  private buffer = Buffer.alloc(0);
  private contentLength: number | undefined;

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      if (this.contentLength === undefined) {
        const boundary = this.buffer.indexOf("\r\n\r\n");
        if (boundary < 0) {
          return;
        }

        const header = this.buffer.subarray(0, boundary).toString("ascii");
        const match = /(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/i.exec(header);
        if (!match) {
          this.emit("error", new Error("analyzer response is missing Content-Length"));
          this.buffer = Buffer.alloc(0);
          return;
        }

        this.contentLength = Number.parseInt(match[1], 10);
        this.buffer = this.buffer.subarray(boundary + 4);
      }

      if (this.buffer.byteLength < this.contentLength) {
        return;
      }

      const body = this.buffer.subarray(0, this.contentLength);
      this.buffer = this.buffer.subarray(this.contentLength);
      this.contentLength = undefined;

      try {
        this.emit("message", JSON.parse(body.toString("utf8")));
      } catch (error) {
        this.emit("error", new Error(`invalid JSON from analyzer: ${String(error)}`));
      }
    }
  }
}
