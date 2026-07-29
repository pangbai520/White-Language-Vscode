# White Language for VS Code

This extension provides syntax highlighting, syntax diagnostics, and other basic VS Code support for White Language.

The extension finds `wlc` through `whitelanguage.compiler.path` or `WL_PATH/bin/wlc`. You can use the run button in the editor title bar to compile and run the current White Language file.

Choose how reported diagnostics are displayed with
`whitelanguage.diagnostics.mode`. 

Cross-file navigation currently covers files opened during the editor session.

## Finding `wlls`

1. `whitelanguage.server.path`
2. `WL_PATH/bin/wlls` (`wlls.exe` on Windows)

## Development

```sh
npm install
npm run check
npm run package
```
