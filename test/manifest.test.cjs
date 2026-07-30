const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const root = resolve(__dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const grammar = JSON.parse(
  readFileSync(resolve(root, "syntaxes", "whitelang.tmLanguage.json"), "utf8"),
);

test("uses the marketplace identity and bundled icons", () => {
  assert.equal(manifest.version, "0.0.1");
  assert.equal(manifest.publisher, "whitelang-dev");
  assert.equal(manifest.icon, "./resources/icon.png");

  const language = manifest.contributes.languages.find(
    (entry) => entry.id === "whitelang",
  );
  assert.deepEqual(language.icon, {
    light: "./resources/light.svg",
    dark: "./resources/dark.svg",
  });
});

test("registers .wl and the semantic token scope mappings", () => {
  const language = manifest.contributes.languages.find(
    (entry) => entry.id === "whitelang",
  );
  assert(language);
  assert(language.extensions.includes(".wl"));

  const mappings = manifest.contributes.semanticTokenScopes[0].scopes;
  for (const tokenType of [
    "keyword",
    "type",
    "class",
    "struct",
    "interface",
    "enum",
    "enumMember",
    "function",
    "method",
    "parameter",
    "variable",
    "property",
    "string",
    "number",
    "comment",
    "operator",
    "annotation",
  ]) {
    assert(mappings[tokenType], `missing scope mapping for ${tokenType}`);
  }
});

test("contributes the White Language run button", () => {
  const command = manifest.contributes.commands.find(
    (entry) => entry.command === "whitelanguage.runFile",
  );
  assert(command);
  assert.equal(command.icon, "$(play)");

  const titleMenu = manifest.contributes.menus["editor/title"].find(
    (entry) => entry.command === "whitelanguage.runFile",
  );
  assert(titleMenu);
  assert.equal(titleMenu.when, "editorLangId == whitelang");
});

test("offers all three diagnostic modes without changing the default behavior", () => {
  const setting = manifest.contributes.configuration.properties[
    "whitelanguage.diagnostics.mode"
  ];
  assert(setting);
  assert.deepEqual(setting.enum, ["workspace", "openFiles", "visitedFiles"]);
  assert.equal(setting.default, "openFiles");
  assert.match(setting.enumDescriptions[0], /server/i);
});

test("loads the fallback grammar as source.whitelang", () => {
  assert.equal(grammar.scopeName, "source.whitelang");
  assert(grammar.patterns.length > 0);
});
