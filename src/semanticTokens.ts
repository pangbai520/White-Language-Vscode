import * as vscode from "vscode";
import { AnalyzerClient, formatError } from "./analyzerClient";
import { AnalyzerSemanticToken, SemanticTokensCapability } from "./protocol";
import { SemanticTokenCache } from "./semanticTokenCache";

export class WhiteSemanticTokensProvider
implements vscode.DocumentSemanticTokensProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeSemanticTokens = this.changeEmitter.event;
  private readonly tokenTypeIndices = new Map<string, number>();
  private readonly modifierIndices = new Map<string, number>();
  private readonly verified = new Set<string>();
  private readonly revalidating = new Map<string, Promise<void>>();

  constructor(
    private readonly client: AnalyzerClient,
    private readonly legend: vscode.SemanticTokensLegend,
    capability: SemanticTokensCapability,
    private readonly output: vscode.OutputChannel,
    private readonly cache: SemanticTokenCache,
  ) {
    capability.tokenTypes.forEach((name, index) => {
      this.tokenTypeIndices.set(name, index);
    });
    capability.tokenModifiers.forEach((name, index) => {
      this.modifierIndices.set(name, index);
    });
  }

  async provideDocumentSemanticTokens(
    document: vscode.TextDocument,
    cancellationToken: vscode.CancellationToken,
  ): Promise<vscode.SemanticTokens> {
    const uri = document.uri.toString();
    const text = document.getText();
    const identity = this.cache.identity(uri, text);
    const cached = await this.cache.load(uri, text);
    if (cached) {
      if (!this.verified.has(identity)) {
        this.revalidate(document, uri, text, identity, cached);
      }
      return new vscode.SemanticTokens(cached);
    }

    try {
      const semanticTokens = await this.fetch(document, cancellationToken);
      await this.cache.save(uri, text, semanticTokens.data);
      this.verified.add(identity);
      return semanticTokens;
    } catch (error) {
      if (error instanceof vscode.CancellationError) {
        throw error;
      }
      this.output.appendLine(
        `semantic highlighting failed for ${document.uri.fsPath}: ${formatError(error)}`,
      );
      return new vscode.SemanticTokens(new Uint32Array());
    }
  }

  refresh(): void {
    this.verified.clear();
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }

  private revalidate(
    document: vscode.TextDocument,
    uri: string,
    text: string,
    identity: string,
    cached: Uint32Array,
  ): void {
    if (this.revalidating.has(identity)) {
      return;
    }

    const version = document.version;
    const operation = this.fetch(document)
      .then(async (semanticTokens) => {
        if (document.version !== version || document.getText() !== text) {
          return;
        }

        await this.cache.save(uri, text, semanticTokens.data);
        this.verified.add(identity);
        if (!equalTokens(cached, semanticTokens.data)) {
          this.changeEmitter.fire();
        }
      })
      .catch((error) => {
        this.output.appendLine(
          `semantic cache refresh failed for ${document.uri.fsPath}: ${formatError(error)}`,
        );
      })
      .finally(() => {
        this.revalidating.delete(identity);
      });
    this.revalidating.set(identity, operation);
  }

  private async fetch(
    document: vscode.TextDocument,
    cancellationToken?: vscode.CancellationToken,
  ): Promise<vscode.SemanticTokens> {
    await this.client.synchronize(document);
    const tokens = await this.client.request<AnalyzerSemanticToken[]>(
      "textDocument/semanticTokens",
      { path: document.uri.fsPath },
      cancellationToken,
    );
    return this.build(tokens);
  }

  private build(tokens: AnalyzerSemanticToken[]): vscode.SemanticTokens {
    const builder = new vscode.SemanticTokensBuilder(this.legend);

    for (const token of tokens) {
      const typeIndex = this.tokenTypeIndices.get(token.type);
      if (
        typeIndex === undefined
        || !Number.isInteger(token.line)
        || !Number.isInteger(token.character)
        || !Number.isInteger(token.length)
        || token.line < 0
        || token.character < 0
        || token.length <= 0
      ) {
        continue;
      }

      let modifierBits = 0;
      for (const modifier of token.modifiers) {
        const index = this.modifierIndices.get(modifier);
        if (index !== undefined && index < 31) {
          modifierBits |= 1 << index;
        }
      }

      builder.push(
        token.line,
        token.character,
        token.length,
        typeIndex,
        modifierBits,
      );
    }

    return builder.build();
  }
}

function equalTokens(left: Uint32Array, right: Uint32Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}
