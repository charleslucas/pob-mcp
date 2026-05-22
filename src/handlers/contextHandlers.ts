/**
 * Context usage handler — reads the Claude Code session JSONL to report
 * real-time token consumption for the current conversation.
 *
 * Performance: reads only the last ~8KB of the JSONL (not the full file),
 * and caches the resolved path after the first successful lookup so
 * subsequent calls pay zero directory-scan cost.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { wrapHandler } from "../utils/errorHandling.js";

// Cached path — set on first successful resolution, reused thereafter.
let _cachedJsonlPath: string | null = null;

/** Convert an absolute CWD to Claude Code's project slug convention.
 *  C:\Users\charl\tools\poe_mcp_suite  →  c--Users-charl-tools-poe-mcp-suite */
function cwdToSlug(cwd: string): string {
  const win = cwd.match(/^([A-Za-z]):[\\\/](.*)/);
  if (win) {
    return win[1].toLowerCase() + "--" + win[2].replace(/[\\\/]/g, "-").replace(/_/g, "-");
  }
  return cwd.replace(/^\//, "").replace(/\//g, "-").replace(/_/g, "-");
}

/** Read only the last `tailBytes` of a file — avoids loading the whole JSONL. */
function readFileTail(filePath: string, tailBytes = 8192): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - tailBytes);
    const buf = Buffer.alloc(Math.min(tailBytes, size));
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, start);
    return buf.slice(0, bytesRead).toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

interface UsageEntry {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/** Parse the last usage entry from the tail string (scans lines in reverse). */
function extractLastUsage(tail: string): UsageEntry | null {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      const u = obj?.message?.usage;
      if (u && typeof u.input_tokens === "number") return u as UsageEntry;
    } catch {
      // incomplete line at start of tail window — skip
    }
  }
  return null;
}

/** Resolve the active session JSONL, using cache when available. */
function resolveJsonlPath(): string | null {
  if (_cachedJsonlPath && fs.existsSync(_cachedJsonlPath)) return _cachedJsonlPath;

  const projectsDir = path.join(os.homedir(), ".claude", "projects");

  // 1. Try direct slug match from CWD first — zero directory listing
  const slug = cwdToSlug(process.cwd());
  const projectDir = path.join(projectsDir, slug);
  if (fs.existsSync(projectDir)) {
    const candidates = fs.readdirSync(projectDir).filter(f => f.endsWith(".jsonl"));
    if (candidates.length > 0) {
      // Pick most recently modified
      const best = candidates
        .map(f => ({ f, mtime: fs.statSync(path.join(projectDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)[0];
      _cachedJsonlPath = path.join(projectDir, best.f);
      return _cachedJsonlPath;
    }
  }

  // 2. Fallback: scan all projects for the most recently modified JSONL
  try {
    let newest = { mtime: 0, p: "" };
    for (const proj of fs.readdirSync(projectsDir)) {
      const pd = path.join(projectsDir, proj);
      if (!fs.statSync(pd).isDirectory()) continue;
      for (const f of fs.readdirSync(pd).filter(f => f.endsWith(".jsonl"))) {
        const fp = path.join(pd, f);
        const mtime = fs.statSync(fp).mtimeMs;
        if (mtime > newest.mtime) newest = { mtime, p: fp };
      }
    }
    if (newest.p) {
      _cachedJsonlPath = newest.p;
      return _cachedJsonlPath;
    }
  } catch { /* ignore */ }

  return null;
}

export async function handleGetContextUsage() {
  return wrapHandler("get context usage", async () => {
    const jsonlPath = resolveJsonlPath();

    if (!jsonlPath) {
      return {
        content: [{
          type: "text" as const,
          text: [
            "Could not locate the Claude Code session log.",
            `Looked for: ~/.claude/projects/${cwdToSlug(process.cwd())}/*.jsonl`,
            "Ensure Claude Code is running with an active session.",
          ].join("\n"),
        }],
      };
    }

    const tail = readFileTail(jsonlPath);        // ~8KB read, not the full file
    const usage = extractLastUsage(tail);

    if (!usage) {
      return {
        content: [{
          type: "text" as const,
          text: `Found session log at ${jsonlPath} but no usage data in last 8KB.`,
        }],
      };
    }

    const contextTokens = usage.cache_read_input_tokens + usage.input_tokens;
    const WINDOW = 200_000;
    const pct = Math.round((contextTokens / WINDOW) * 100);
    const filled = Math.min(20, Math.round(pct / 5));
    const bar = "█".repeat(filled) + "░".repeat(20 - filled);

    const lines = [
      "=== Claude Code Context Usage ===",
      "",
      `Context now:  ${contextTokens.toLocaleString()} tokens`,
      `Window:       ${WINDOW.toLocaleString()} tokens  (compaction activates near limit)`,
      `Usage:        ${bar} ${pct}%`,
      "",
      "Last turn breakdown:",
      `  Cached (re-read):  ${usage.cache_read_input_tokens.toLocaleString()} tokens`,
      `  New (uncached):    ${usage.input_tokens.toLocaleString()} tokens`,
      `  Cache written:     ${usage.cache_creation_input_tokens.toLocaleString()} tokens`,
      `  Output:            ${usage.output_tokens.toLocaleString()} tokens`,
    ];

    if (pct >= 80) {
      lines.push("", "⚠️  >80% full — save key findings to character_data/ before continuing.");
    } else if (pct >= 60) {
      lines.push("", "ℹ️  >60% full — prefer compact tool outputs for remaining work.");
    }

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  });
}
