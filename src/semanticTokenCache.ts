import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

const magic = Buffer.from("WLST\x01\0\0\0", "binary");
const maxEntries = 64;
const maxBytes = 64 * 1024 * 1024;

export class SemanticTokenCache {
  constructor(
    private readonly directory: string,
    private readonly namespace: string,
  ) {}

  async load(uri: string, text: string): Promise<Uint32Array | undefined> {
    const path = this.pathFor(uri, text);

    try {
      const handle = await open(path, "r");
      try {
        const info = await handle.stat();
        const payloadBytes = info.size - magic.byteLength;
        if (
          payloadBytes < 0
          || payloadBytes % Uint32Array.BYTES_PER_ELEMENT !== 0
          || payloadBytes > maxBytes
        ) {
          return undefined;
        }

        const bytes = Buffer.allocUnsafe(info.size);
        await handle.read(bytes, 0, bytes.byteLength, 0);
        if (!bytes.subarray(0, magic.byteLength).equals(magic)) {
          return undefined;
        }

        const payload = bytes.subarray(magic.byteLength);
        const result = new Uint32Array(payloadBytes / Uint32Array.BYTES_PER_ELEMENT);
        for (let index = 0; index < result.length; index += 1) {
          result[index] = payload.readUInt32LE(index * Uint32Array.BYTES_PER_ELEMENT);
        }
        return result;
      } finally {
        await handle.close();
      }
    } catch {
      return undefined;
    }
  }

  identity(uri: string, text: string): string {
    return createHash("sha256")
      .update(this.namespace)
      .update("\0")
      .update(uri)
      .update("\0")
      .update(text)
      .digest("hex");
  }

  async save(uri: string, text: string, data: Uint32Array): Promise<void> {
    if (data.byteLength > maxBytes) {
      return;
    }

    await mkdir(this.directory, { recursive: true });
    const path = this.pathFor(uri, text);
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    const bytes = Buffer.allocUnsafe(magic.byteLength + data.byteLength);
    magic.copy(bytes, 0);
    for (let index = 0; index < data.length; index += 1) {
      bytes.writeUInt32LE(data[index], magic.byteLength + index * Uint32Array.BYTES_PER_ELEMENT);
    }

    try {
      await writeFile(temporary, bytes, { flag: "wx" });
      await rename(temporary, path);
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
    }

    await this.prune().catch(() => undefined);
  }

  private pathFor(uri: string, text: string): string {
    return join(this.directory, `${this.identity(uri, text)}.tokens`);
  }

  private async prune(): Promise<void> {
    const names = await readdir(this.directory);
    const entries = [];

    for (const name of names) {
      if (!name.endsWith(".tokens")) {
        continue;
      }
      const path = join(this.directory, name);
      try {
        const info = await stat(path);
        entries.push({
          path,
          size: info.size,
          modified: info.mtimeMs,
        });
      } catch {
        // another extension host may be pruning the same cache
      }
    }

    entries.sort((left, right) => right.modified - left.modified);
    let bytes = 0;
    for (let index = 0; index < entries.length; index += 1) {
      bytes += entries[index].size;
      if (index >= maxEntries || bytes > maxBytes) {
        await rm(entries[index].path, { force: true });
      }
    }
  }
}
