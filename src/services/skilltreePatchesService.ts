/**
 * Skilltree Patches Service
 *
 * Reads and writes `reference_data/skilltree/data_patches.json` — the overlay
 * file that carries verified corrections to GGG's published tree data. See
 * `reference_data/skilltree/PATCHES.md` (inside the fork submodule) for the
 * file format, operation semantics, and the rules about NOT patching jewel-
 * transformed nodes.
 *
 * Workflow:
 *   getPatches()          — load (empty object if file missing)
 *   getPatch(nodeId)      — single node
 *   upsertPatch(...)      — add or update an entry; stamps verified_date today
 *   removePatch(nodeId)   — delete an entry
 *   listPatchesSummary()  — audit-friendly list
 *
 * Writes are atomic (tmp file + rename). On-disk JSON is pretty-printed
 * (2-space indent) so diffs are git-friendly.
 *
 * Per legal_considerations.md: patches are limited to the same structural
 * tree data the suite already publishes. The protocol doc inside the fork
 * defines the contributor-facing rules.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

export type PatchOperation = "stats_add" | "stats_replace" | "name_replace" | "flags_set";

export type PatchSource =
  | "in-game tooltip"
  | "PoB tree data"
  | "PoB lua_get_passive_detail"
  | "wiki"
  | "reddit/forum";

export interface PatchEntry {
  stats_add?: string[];
  stats_replace?: string[];
  name_replace?: string;
  flags_set?: Record<string, boolean | string | null>;
  verified_from: PatchSource;
  verified_date: string; // YYYY-MM-DD
  verified_by: string;
  note?: string;
}

export type PatchesFile = Record<string, PatchEntry>;

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Locate the skilltree fork submodule. process.cwd() is unreliable in MCP
 * deployments (server typically launches from PoB's builds dir, not the
 * suite). Resolve from this module's filesystem location instead.
 *   <suite>/pob-mcp/{src,build}/services/skilltreePatchesService.{ts,js}
 * walk up 3 dirs -> <suite>/, then into reference_data/skilltree/.
 */
// Walks up from the given dir looking for a `pob-mcp/package.json` marker.
// See pobTreeDataLoader.resolveSuiteRoot for the full reasoning.
function searchUpwardForSuite(start: string): string | null {
  let dir = start;
  while (dir && dir !== dirname(dir)) {
    if (existsSync(join(dir, "pob-mcp", "package.json"))) return dir;
    dir = dirname(dir);
  }
  return null;
}

function resolveSuiteRoot(): string {
  if (process.env.POE_MCP_SUITE_ROOT) return process.env.POE_MCP_SUITE_ROOT;
  const entry = process.argv[1];
  if (entry) {
    const found = searchUpwardForSuite(dirname(entry));
    if (found) return found;
  }
  const cwdFound = searchUpwardForSuite(process.cwd());
  if (cwdFound) return cwdFound;
  return process.cwd();
}

function resolveSkilltreeDir(): string {
  if (process.env.SKILLTREE_DIRECTORY) return process.env.SKILLTREE_DIRECTORY;
  return join(resolveSuiteRoot(), "reference_data", "skilltree");
}

function patchesFilePath(): string {
  return join(resolveSkilltreeDir(), "data_patches.json");
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export function getPatches(): PatchesFile {
  const path = patchesFilePath();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as PatchesFile;
    }
    return {};
  } catch (err) {
    throw new Error(
      `Failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export function getPatch(nodeId: string): PatchEntry | null {
  const patches = getPatches();
  return patches[nodeId] ?? null;
}

// ---------------------------------------------------------------------------
// Write (atomic)
// ---------------------------------------------------------------------------

function writePatchesAtomic(patches: PatchesFile): void {
  const finalPath = patchesFilePath();
  const dir = dirname(finalPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = finalPath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(patches, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, finalPath);
}

function todayIsoDate(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export interface UpsertPatchArgs {
  nodeId: string;
  operation: PatchOperation;
  value: string | string[] | Record<string, boolean | string | null>;
  verified_from: PatchSource;
  verified_by: string;
  note?: string;
}

export interface UpsertResult {
  action: "created" | "updated";
  path: string;
  entry: PatchEntry;
  previous: PatchEntry | null;
}

/**
 * Add or update a patch entry. Stamps `verified_date` with today's UTC date.
 * If an entry already exists, the new operation supersedes the previous one
 * (the previous entry is returned in `previous` so callers can preserve
 * context if they want).
 */
export function upsertPatch(args: UpsertPatchArgs): UpsertResult {
  const patches = getPatches();
  const previous = patches[args.nodeId] ?? null;

  // Build the new entry. Each upsert replaces the entire entry rather than
  // merging operations — keeps semantics predictable. Callers wanting to add
  // ON TOP of an existing patch should fetch the prior entry first via
  // getPatch() and combine.
  const entry: PatchEntry = {
    verified_from: args.verified_from,
    verified_date: todayIsoDate(),
    verified_by: args.verified_by,
  };
  if (args.note) entry.note = args.note;

  switch (args.operation) {
    case "stats_add":
      if (!Array.isArray(args.value)) {
        throw new Error("stats_add requires `value` to be an array of strings");
      }
      entry.stats_add = args.value as string[];
      break;
    case "stats_replace":
      if (!Array.isArray(args.value)) {
        throw new Error("stats_replace requires `value` to be an array of strings");
      }
      entry.stats_replace = args.value as string[];
      break;
    case "name_replace":
      if (typeof args.value !== "string") {
        throw new Error("name_replace requires `value` to be a string");
      }
      entry.name_replace = args.value;
      break;
    case "flags_set":
      if (!args.value || typeof args.value !== "object" || Array.isArray(args.value)) {
        throw new Error("flags_set requires `value` to be an object of flag -> value");
      }
      entry.flags_set = args.value as Record<string, boolean | string | null>;
      break;
    default:
      throw new Error(`Unknown operation: ${args.operation}`);
  }

  patches[args.nodeId] = entry;
  writePatchesAtomic(patches);
  return {
    action: previous ? "updated" : "created",
    path: patchesFilePath(),
    entry,
    previous,
  };
}

export interface RemoveResult {
  action: "removed" | "not_found";
  path: string;
  previous: PatchEntry | null;
}

export function removePatch(nodeId: string): RemoveResult {
  const patches = getPatches();
  const previous = patches[nodeId] ?? null;
  if (!previous) {
    return { action: "not_found", path: patchesFilePath(), previous: null };
  }
  delete patches[nodeId];
  writePatchesAtomic(patches);
  return { action: "removed", path: patchesFilePath(), previous };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface PatchSummary {
  nodeId: string;
  operations: PatchOperation[];
  verified_from: PatchSource;
  verified_date: string;
  verified_by: string;
  age_days: number;
  note?: string;
}

export function listPatchesSummary(): PatchSummary[] {
  const patches = getPatches();
  const todayMs = new Date(todayIsoDate() + "T00:00:00Z").getTime();
  const summaries: PatchSummary[] = [];
  for (const [nodeId, entry] of Object.entries(patches)) {
    const ops: PatchOperation[] = [];
    if (entry.stats_add) ops.push("stats_add");
    if (entry.stats_replace) ops.push("stats_replace");
    if (entry.name_replace !== undefined) ops.push("name_replace");
    if (entry.flags_set) ops.push("flags_set");
    const dateMs = new Date(entry.verified_date + "T00:00:00Z").getTime();
    const ageDays = Math.max(0, Math.floor((todayMs - dateMs) / 86_400_000));
    summaries.push({
      nodeId,
      operations: ops,
      verified_from: entry.verified_from,
      verified_date: entry.verified_date,
      verified_by: entry.verified_by,
      age_days: ageDays,
      note: entry.note,
    });
  }
  return summaries.sort((a, b) => b.age_days - a.age_days);
}

export function getPatchesFilePath(): string {
  return patchesFilePath();
}
