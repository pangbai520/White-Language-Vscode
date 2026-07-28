const assert = require("node:assert/strict");
const test = require("node:test");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { SemanticTokenCache } = require("../out/semanticTokenCache.js");

test("restores tokens only for the same content and namespace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "whitelanguage-token-cache-"));
  try {
    const data = new Uint32Array([0, 5, 4, 7, 1, 0, 6, 3, 10, 0]);
    const cache = new SemanticTokenCache(directory, "legend-a");
    await cache.save("file:///main.wl", "func main() {}", data);

    assert.deepEqual(
      await cache.load("file:///main.wl", "func main() {}"),
      data,
    );
    assert.equal(
      await cache.load("file:///main.wl", "func changed() {}"),
      undefined,
    );

    const differentLegend = new SemanticTokenCache(directory, "legend-b");
    assert.equal(
      await differentLegend.load("file:///main.wl", "func main() {}"),
      undefined,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
