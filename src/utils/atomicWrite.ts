import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";

const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * Replace a file's contents so that a failed or interrupted write never leaves a
 * truncated file behind: write a sibling temp file, fsync it, then rename it over the
 * target. Readers (PoB, OneDrive sync) see the old version or the new one, never half.
 *
 * Ported from pob-mcp upstream 7a75042 (utils/atomicWrite.ts), with two changes:
 * overwrite-only (our callers always replaced the file), and a short retry on
 * EPERM/EBUSY/EACCES, because on Windows a sync client or scanner can hold the
 * target open for a moment and MoveFileEx refuses to replace it.
 */
export async function atomicWriteFile(filePath: string, content: string | Buffer): Promise<void> {
  const temporary = path.join(path.dirname(filePath), `.pob-write-${randomUUID()}.tmp`);
  try {
    let mode: number | undefined;
    try {
      mode = (await fs.stat(filePath)).mode;
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    const file = await fs.open(temporary, "wx", mode);
    try {
      await file.writeFile(content, typeof content === "string" ? "utf8" : undefined);
      await file.sync();
    } finally {
      await file.close();
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(temporary, filePath);
        break;
      } catch (error: any) {
        if (attempt >= 4 || !RENAME_RETRY_CODES.has(error.code)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
      }
    }
  } finally {
    await fs.unlink(temporary).catch((error: any) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
