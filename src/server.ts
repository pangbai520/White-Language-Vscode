import { join } from "node:path";
import * as vscode from "vscode";
import { isExecutableFile, resolveConfiguredPath } from "./executable";

export async function findServer(): Promise<string | undefined> {
  const configured = vscode.workspace
    .getConfiguration("whitelanguage")
    .get<string>("server.path", "")
    .trim();
  const executableName = process.platform === "win32" ? "wlls.exe" : "wlls";
  const candidates: string[] = [];

  if (configured) {
    candidates.push(resolveConfiguredPath(configured));
  }

  const wlPath = process.env.WL_PATH;
  if (wlPath) {
    candidates.push(join(wlPath, "bin", executableName));
  }

  for (const candidate of new Set(candidates)) {
    if (await isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
