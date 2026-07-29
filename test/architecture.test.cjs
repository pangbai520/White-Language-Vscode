const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const root = resolve(__dirname, "..");
const extension = readFileSync(resolve(root, "src", "extension.ts"), "utf8");
const diagnosticPolicy = readFileSync(
  resolve(root, "src", "diagnosticPolicy.ts"),
  "utf8",
);
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const vscodeIgnore = readFileSync(resolve(root, ".vscodeignore"), "utf8");

test("uses one standard LSP document lifecycle", () => {
  assert.match(extension, /new LanguageClient/);
  assert.doesNotMatch(extension, /openTextDocument|findFiles|sendNotification/);
  assert.doesNotMatch(extension, /textDocument\/(?:didOpen|didChange|didClose)/);
});

test("drops transient semantic and outline requests before they reach wlls", () => {
  assert.match(extension, /provideDocumentSemanticTokens/);
  assert.match(extension, /provideDocumentSymbols/);
  assert.match(extension, /waitForVisibleDocument/);
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
