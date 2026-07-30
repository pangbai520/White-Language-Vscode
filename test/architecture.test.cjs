const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const root = resolve(__dirname, "..");
const extension = readFileSync(resolve(root, "src", "extension.ts"), "utf8");
const server = readFileSync(resolve(root, "src", "server.ts"), "utf8");
const diagnosticPolicy = readFileSync(
  resolve(root, "src", "diagnosticPolicy.ts"),
  "utf8",
);
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const vscodeIgnore = readFileSync(resolve(root, ".vscodeignore"), "utf8");

test("uses one standard LSP document lifecycle", () => {
  assert.match(extension, /new LanguageClient/);
  assert.doesNotMatch(extension, /openTextDocument|findFiles/);
  assert.doesNotMatch(extension, /sendNotification/);
  assert.doesNotMatch(extension, /textDocument\/(?:didOpen|didChange|didClose)/);
});

test("passes semantic and outline requests directly to the LSP client", () => {
  assert.doesNotMatch(extension, /provideDocumentSemanticTokens/);
  assert.doesNotMatch(extension, /provideDocumentSymbols/);
  assert.doesNotMatch(extension, /waitForVisibleDocument/);
  assert.doesNotMatch(extension, /SemanticTokensRegistrationType/);
  assert.doesNotMatch(extension, /onDidChangeSemanticTokensEmitter/);
  assert.doesNotMatch(extension, /refreshSemanticTokens/);
});

test("passes a validated White Language root to wlls", () => {
  assert.match(extension, /findWhiteLanguageRoot\(executable\)/);
  assert.match(extension, /options:\s*\{[\s\S]*env:\s*\{/);
  assert.match(extension, /WL_PATH:\s*wlPath/);
  assert.match(server, /dirname\(dirname\(executable\)\)/);
  assert.match(server, /stat\(join\(path,\s*"std"\)\)/);
  assert.match(server, /stat\(join\(path,\s*"runtime"\)\)/);
});

test("preserves cached diagnostics only in non-open-file modes", () => {
  assert.match(extension, /beforeDocumentClose/);
  assert.match(diagnosticPolicy, /this\.mode !== "openFiles"/);
  assert.match(diagnosticPolicy, /reset\(\)/);
});

test("bundles the language client without shipping build artifacts", () => {
  assert.match(manifest.scripts.compile, /scripts\/build\.mjs/);
  assert.match(vscodeIgnore, /node_modules\/\*\*/);
  assert.match(vscodeIgnore, /out\/\*\*\/\*\.map/);
});
