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

interface SessionInfo {
  usage: UsageEntry;
  model: string | null;
}

/** Known model context windows and characteristics. */
const MODEL_INFO: Record<string, { window: string; notes: string }> = {
  "claude-opus-4-7":            { window: "200K", notes: "Most capable; best for complex multi-step reasoning" },
  "claude-sonnet-4-6":          { window: "200K", notes: "Balanced capability and speed; good default" },
  "claude-haiku-4-5-20251001":  { window: "200K", notes: "Fastest; best for simple lookups and lightweight tasks" },
};

/** Parse the last usage entry and model from the tail string (scans lines in reverse). */
function extractSessionInfo(tail: string): SessionInfo | null {
  const lines = tail.split("\n");
  let usage: UsageEntry | null = null;
  let model: string | null = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      const msg = obj?.message ?? {};
      if (!usage && msg.usage && typeof msg.usage.input_tokens === "number") {
        usage = msg.usage as UsageEntry;
      }
      if (!model && msg.model && typeof msg.model === "string") {
        model = msg.model;
      }
      if (usage && model) break;
    } catch {
      // incomplete line at start of tail window — skip
    }
  }

  return usage ? { usage, model } : null;
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
    const info = extractSessionInfo(tail);

    if (!info) {
      return {
        content: [{
          type: "text" as const,
          text: `Found session log at ${jsonlPath} but no usage data in last 8KB.`,
        }],
      };
    }

    const { usage, model } = info;
    const modelId = model ?? "unknown";
    const modelMeta = MODEL_INFO[modelId];

    // cache_read_input_tokens = all tokens served from the prompt cache this turn.
    // This represents the accumulated conversation state and CAN exceed the nominal
    // context window because auto-compaction + layered caching allow the session to
    // grow beyond a single window. Treat it as a session-length proxy, not a hard ceiling.
    const contextTokens = info.usage.cache_read_input_tokens + info.usage.input_tokens;

    // Thresholds based on observed behaviour, not a hard window size.
    // ~100K: light session.  ~200K: medium.  ~400K+: compaction likely already running.
    const MEDIUM = 200_000;
    const HEAVY  = 400_000;
    const barFill = Math.min(20, Math.round((contextTokens / HEAVY) * 20));
    const bar = "█".repeat(barFill) + "░".repeat(20 - barFill);

    const sessionLabel =
      contextTokens < MEDIUM ? "Light" :
      contextTokens < HEAVY  ? "Medium (compaction may activate soon)" :
                                "Heavy (auto-compaction likely already running)";

    const lines = [
      "=== Claude Code Context Usage ===",
      "",
      `Model:          ${modelId}${modelMeta ? ` (${modelMeta.window} window — ${modelMeta.notes})` : ""}`,
      `Cached context: ${contextTokens.toLocaleString()} tokens  [${sessionLabel}]`,
      `Session bar:    ${bar}  (scaled to 400K; can exceed this via compaction)`,
      "",
      "Last turn breakdown:",
      `  Cached (re-read):  ${info.usage.cache_read_input_tokens.toLocaleString()} tokens`,
      `  New (uncached):    ${info.usage.input_tokens.toLocaleString()} tokens`,
      `  Cache written:     ${info.usage.cache_creation_input_tokens.toLocaleString()} tokens`,
      `  Output:            ${info.usage.output_tokens.toLocaleString()} tokens`,
      "",
      "Note: cache_read_input_tokens reflects accumulated session state across",
      "compaction layers — it is not directly comparable to a fixed context window.",
    ];

    if (contextTokens >= HEAVY) {
      lines.push("", "⚠️  Heavy session — save key findings to character_data/ before large data loads.");
    } else if (contextTokens >= MEDIUM) {
      lines.push("", "ℹ️  Medium session — prefer compact tool outputs; compaction may activate soon.");
    }

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  });
}
