# White Language for VS Code

This extension provides syntax highlighting, syntax diagnostics, and other basic VS Code support for White Language.

The extension finds `wlc` through `whitelanguage.compiler.path` or `WL_PATH/bin/wlc`. You can use the run button in the editor title bar to compile and run the current White Language file.

Choose how reported diagnostics are displayed with
`whitelanguage.diagnostics.mode`. 

wlls resolves imported project and standard-library sources on demand.

## Finding `wlls`

1. `whitelanguage.server.path`
2. `WL_PATH/bin/wlls` (`wlls.exe` on Windows)
3. `WL_PATH/tools/wlls/bin/wlls`

If wlls is missing, the extension builds the latest tagged release with git and wlc, then installs it under `WL_PATH/tools/wlls`.

## Development

```sh
npm install
npm run check
npm run package
```
