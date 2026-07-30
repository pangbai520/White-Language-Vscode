import { join } from "node:path";
import * as vscode from "vscode";
import { isExecutableFile, resolveConfiguredPath } from "./executable";

export async function findCompiler(): Promise<string | undefined> {
  const configured = vscode.workspace
    .getConfiguration("whitelanguage")
    .get<string>("compiler.path", "")
    .trim();
  const executableName = process.platform === "win32" ? "wlc.exe" : "wlc";
  const candidates: string[] = [];

  if (configured) {
    candidates.push(resolveConfiguredPath(configured));
  }
  if (process.env.WL_PATH) {
    candidates.push(join(process.env.WL_PATH, "bin", executableName));
  }

  for (const candidate of new Set(candidates)) {
    if (await isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
