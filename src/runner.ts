import { createHash } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import * as vscode from "vscode";

export function registerRunner(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand("whitelanguage.runFile", async () => {
    const editor = vscode.window.activeTextEditor;
    if (
      !editor
      || editor.document.languageId !== "whitelang"
      || editor.document.uri.scheme !== "file"
    ) {
      void vscode.window.showWarningMessage("Open a White Language file to run it.");
      return;
    }

    if (editor.document.isDirty && !await editor.document.save()) {
      return;
    }

    const compiler = await findCompiler();
    if (!compiler) {
      const action = await vscode.window.showErrorMessage(
        "White Language compiler was not found.",
        "Open Settings",
      );
      if (action === "Open Settings") {
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "whitelanguage.compiler.path",
        );
      }
      return;
    }

    const source = editor.document.uri.fsPath;
    const runDirectory = join(context.globalStorageUri.fsPath, "run");
    await mkdir(runDirectory, { recursive: true });
    const sourceName = basename(source, extname(source));
    const sourceId = createHash("sha256").update(source).digest("hex").slice(0, 12);
    const executableName = process.platform === "win32"
      ? `${sourceName}-${sourceId}.exe`
      : `${sourceName}-${sourceId}`;
    const executable = join(runDirectory, executableName);
    const scope = vscode.workspace.getWorkspaceFolder(editor.document.uri)
      ?? vscode.TaskScope.Global;

    const compileTask = new vscode.Task(
      {
        type: "whitelanguage",
        action: "compile",
        source,
        nonce: Date.now(),
      },
      scope,
      `Compile ${basename(source)}`,
      "White Language",
      new vscode.ProcessExecution(
        compiler,
        [source, "-o", executable],
        { cwd: dirname(source) },
      ),
    );
    compileTask.presentationOptions = {
      reveal: vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.Dedicated,
      clear: true,
      focus: false,
    };

    output.appendLine(`compiling ${source}`);
    const compileExecution = await vscode.tasks.executeTask(compileTask);
    const exitCode = await waitForExit(compileExecution);
    if (exitCode !== 0) {
      output.appendLine(`compilation failed (${exitCode ?? "unknown exit code"})`);
      return;
    }

    const runTask = new vscode.Task(
      {
        type: "whitelanguage",
        action: "run",
        source,
        nonce: Date.now(),
      },
      scope,
      `Run ${basename(source)}`,
      "White Language",
      new vscode.ProcessExecution(executable, [], { cwd: dirname(source) }),
    );
    runTask.presentationOptions = {
      reveal: vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.Dedicated,
      clear: false,
      focus: true,
    };
    await vscode.tasks.executeTask(runTask);
  });
}

async function findCompiler(): Promise<string | undefined> {
  const configured = vscode.workspace
    .getConfiguration("whitelanguage")
    .get<string>("compiler.path", "")
    .trim();
  const executableName = process.platform === "win32" ? "wlc.exe" : "wlc";
  const candidates = [];

  if (configured) {
    candidates.push(isAbsolute(configured) ? configured : resolve(configured));
  }
  if (process.env.WL_PATH) {
    candidates.push(join(process.env.WL_PATH, "bin", executableName));
  }

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try the next configured location
    }
  }
  return undefined;
}

function waitForExit(execution: vscode.TaskExecution): Promise<number | undefined> {
  return new Promise((resolveExit) => {
    const subscription = vscode.tasks.onDidEndTaskProcess((event) => {
      if (event.execution === execution) {
        subscription.dispose();
        resolveExit(event.exitCode);
      }
    });
  });
}
