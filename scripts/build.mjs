import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { build } from "esbuild";

const result = await build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
  minify: true,
  sourcemap: "external",
  sourcesContent: false,
  outfile: "out/extension.js",
  write: false,
});

for (const file of result.outputFiles) {
  await mkdir(dirname(file.path), { recursive: true });
  await writeFile(file.path, file.contents);
}
