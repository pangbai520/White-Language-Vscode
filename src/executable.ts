import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import * as vscode from "vscode";

export function resolveConfiguredPath(path: string): string {
  if (isAbsolute(path)) {
    return path;
  }
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return resolve(workspaceRoot ?? process.cwd(), path);
}

export async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) {
      return false;
    }
    await access(
      path,
      process.platform === "win32" ? constants.F_OK : constants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}
