/**
 * Context usage handler — reads the Claude Code session JSONL to report
 * real-time token consumption for the current conversation.
 *
 * Path resolution:
 *   ~/.claude/projects/{cwd-slug}/{session-uuid}.jsonl
 *
 * cwd-slug transformation (matching Claude Code's convention):
 *   C:\Users\charl\tools\poe_mcp_suite  →  c--Users-charl-tools-poe-mcp-suite
 *   /home/charl/poe                      →  home-charl-poe
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { wrapHandler } from "../utils/errorHandling.js";

/** Derive the Claude Code project slug from an absolute path. */
function cwdToSlug(cwd: string): string {
  // Windows: C:\Users\foo  →  c--Users-foo
  const winMatch = cwd.match(/^([A-Za-z]):[\\\/](.*)/);
  if (winMatch) {
    const rest = winMatch[2].replace(/[\\\/]/g, "-").replace(/_/g, "-");
    return winMatch[1].toLowerCase() + "--" + rest;
  }
  // Unix: /home/foo  →  home-foo
  return cwd.replace(/^\//, "").replace(/\//g, "-").replace(/_/g, "-");
}

interface UsageEntry {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

function parseLastUsage(jsonlPath: string): UsageEntry | null {
  let lastUsage: UsageEntry | null = null;
  try {
    const content = fs.readFileSync(jsonlPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    // Scan from the end to find the most recent usage entry
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        const usage = obj?.message?.usage;
        if (usage && typeof usage.input_tokens === "number") {
          lastUsage = usage as UsageEntry;
          break;
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    return null;
  }
  return lastUsage;
}

export async function handleGetContextUsage() {
  return wrapHandler("get context usage", async () => {
    const projectsDir = path.join(os.homedir(), ".claude", "projects");
    const cwd = process.cwd();
    const slug = cwdToSlug(cwd);
    const projectDir = path.join(projectsDir, slug);

    // Find the most recently modified .jsonl in this project dir
    let jsonlPath: string | null = null;
    try {
      const files = fs.readdirSync(projectDir)
        .filter(f => f.endsWith(".jsonl"))
        .map(f => ({ f, mtime: fs.statSync(path.join(projectDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (files.length > 0) {
        jsonlPath = path.join(projectDir, files[0].f);
      }
    } catch {
      // project dir not found — try scanning all projects for most recent
      try {
        let newest = { mtime: 0, p: "" };
        for (const proj of fs.readdirSync(projectsDir)) {
          const pd = path.join(projectsDir, proj);
          for (const f of fs.readdirSync(pd).filter(f => f.endsWith(".jsonl"))) {
            const fp = path.join(pd, f);
            const mtime = fs.statSync(fp).mtimeMs;
            if (mtime > newest.mtime) newest = { mtime, p: fp };
          }
        }
        if (newest.p) jsonlPath = newest.p;
      } catch {
        // ignore
      }
    }

    if (!jsonlPath) {
      return {
        content: [{
          type: "text" as const,
          text: [
            "Could not locate the Claude Code session log.",
            `Expected: ~/.claude/projects/${slug}/*.jsonl`,
            "This tool requires Claude Code to be running with an active session.",
          ].join("\n"),
        }],
      };
    }

    const usage = parseLastUsage(jsonlPath);
    if (!usage) {
      return {
        content: [{
          type: "text" as const,
          text: `Found session log at ${jsonlPath} but could not parse usage data.`,
        }],
      };
    }

    // Context size = cache_read (existing conversation) + input_tokens (new uncached)
    const contextTokens = usage.cache_read_input_tokens + usage.input_tokens;
    // Claude Opus 4.x supports up to 200K context; beyond that compaction kicks in
    const WINDOW = 200_000;
    const pct = Math.round((contextTokens / WINDOW) * 100);
    const bar = "█".repeat(Math.min(20, Math.round(pct / 5))) +
                "░".repeat(Math.max(0, 20 - Math.round(pct / 5)));

    const lines = [
      "=== Claude Code Context Usage ===",
      "",
      `Context now:  ${contextTokens.toLocaleString()} tokens`,
      `Window:       ${WINDOW.toLocaleString()} tokens (200K; compaction activates near limit)`,
      `Usage:        ${bar} ${pct}%`,
      "",
      "Last turn breakdown:",
      `  Cached (re-read):  ${usage.cache_read_input_tokens.toLocaleString()} tokens`,
      `  New (uncached):    ${usage.input_tokens.toLocaleString()} tokens`,
      `  Cache written:     ${usage.cache_creation_input_tokens.toLocaleString()} tokens`,
      `  Output:            ${usage.output_tokens.toLocaleString()} tokens`,
      "",
      `Session log: ${jsonlPath}`,
    ];

    if (pct >= 80) {
      lines.push("");
      lines.push("⚠️  Context is over 80% full. Consider saving key findings to character_data/");
      lines.push("   and starting a fresh session for heavy data loads.");
    } else if (pct >= 60) {
      lines.push("");
      lines.push("ℹ️  Context is over 60% full. Prefer compact tool outputs for remaining work.");
    }

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  });
}
