/**
 * PoB Tree Data Loader
 *
 * Reads PoB community's `PathOfBuilding/src/TreeData/{version}/tree.lua` and
 * parses it via luaparse into a JS object. PoB maintains tree.lua for each
 * PoE league, updated via PR. The schema is identical to GGG's published
 * data.json (same readable field names: name, stats, group, orbit, orbitIndex,
 * isNotable, etc.) so consumers can treat the parsed output as a drop-in
 * substitute for GGG's export.
 *
 * Known difference from GGG: PoB renumbers `group` IDs in their own internal
 * order. Node IDs are stable across both; the `group` field is not.
 *
 * Legal: per legal_considerations.md, this only exposes the kind of structural
 * tree data GGG already publishes themselves. Stat description templates,
 * AlternatePassiveSkills tables, and other content-rich game data are not
 * read here.
 */

import { readFileSync, statSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import luaparse from "luaparse";

export interface PobNode {
  skill: number;
  name: string;
  icon?: string;
  stats: string[];
  group: number;
  orbit: number;
  orbitIndex: number;
  in: string[];
  out: string[];
  isNotable?: boolean;
  isKeystone?: boolean;
  isJewelSocket?: boolean;
  isMastery?: boolean;
  ascendancyName?: string;
  isAscendancyStart?: boolean;
  recipe?: string[];
  passivePointsGranted?: number;
  isMultipleChoice?: boolean;
  isMultipleChoiceOption?: boolean;
  flavourText?: string[];
  reminderText?: string[];
  spc?: unknown;
  [key: string]: unknown;
}

export interface PobGroup {
  x: number;
  y: number;
  orbits: number[];
  nodes: string[];
  background?: { image?: string; isHalfImage?: boolean; offsetX?: number; offsetY?: number };
}

export interface PobTreeData {
  tree: string;
  classes: unknown[];
  groups: Record<string, PobGroup>;
  nodes: Record<string, PobNode>;
  min_x?: number;
  min_y?: number;
  max_x?: number;
  max_y?: number;
  constants?: unknown;
  points?: unknown;
  jewelSlots?: unknown;
  alternate_ascendancies?: unknown;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Lua AST -> JS object
// ---------------------------------------------------------------------------

type LuaNode = {
  type: string;
  value?: unknown;
  raw?: string;
  operator?: string;
  argument?: LuaNode;
  fields?: LuaField[];
  name?: string;
};

type LuaField = {
  type: "TableKey" | "TableKeyString" | "TableValue";
  key?: LuaNode | { type: "Identifier"; name: string };
  value: LuaNode;
};

function luaToJs(node: LuaNode | null | undefined): unknown {
  if (!node) return null;
  switch (node.type) {
    case "NumericLiteral":
      return node.value !== null && node.value !== undefined
        ? (node.value as number)
        : Number(node.raw);
    case "StringLiteral": {
      if (node.value !== null && node.value !== undefined) return node.value;
      const raw = node.raw ?? "";
      if (
        (raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'"))
      ) {
        return raw
          .slice(1, -1)
          .replace(/\\n/g, "\n")
          .replace(/\\t/g, "\t")
          .replace(/\\r/g, "\r")
          .replace(/\\"/g, '"')
          .replace(/\\'/g, "'")
          .replace(/\\\\/g, "\\");
      }
      const m = raw.match(/^\[(=*)\[([\s\S]*)\]\1\]$/);
      if (m) return m[2];
      return raw;
    }
    case "BooleanLiteral":
      return node.value;
    case "NilLiteral":
      return null;
    case "UnaryExpression":
      if (node.operator === "-") {
        const arg = luaToJs(node.argument);
        return typeof arg === "number" ? -arg : null;
      }
      return null;
    case "TableConstructorExpression": {
      const fields = node.fields ?? [];
      const isSequence =
        fields.length > 0 && fields.every((f) => f.type === "TableValue");
      if (isSequence) {
        return fields.map((f) => luaToJs(f.value));
      }
      const obj: Record<string, unknown> = {};
      let implicitIndex = 1;
      for (const field of fields) {
        if (field.type === "TableKey") {
          const key = luaToJs(field.key as LuaNode);
          obj[String(key)] = luaToJs(field.value);
        } else if (field.type === "TableKeyString") {
          const k = (field.key as { name: string }).name;
          obj[k] = luaToJs(field.value);
        } else if (field.type === "TableValue") {
          obj[String(implicitIndex++)] = luaToJs(field.value);
        }
      }
      return obj;
    }
    default:
      return null;
  }
}

function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object" && Object.keys(v as object).length === 0) return [];
  return v ? [v] : [];
}

function normalizeNode(raw: Record<string, unknown>): PobNode {
  const out: PobNode = { ...(raw as PobNode) };
  out.stats = asArray(raw.stats) as string[];
  out.in = asArray(raw.in) as string[];
  out.out = asArray(raw.out) as string[];
  if (raw.recipe) out.recipe = asArray(raw.recipe) as string[];
  if (raw.flavourText) out.flavourText = asArray(raw.flavourText) as string[];
  if (raw.reminderText) out.reminderText = asArray(raw.reminderText) as string[];
  return out;
}

// ---------------------------------------------------------------------------
// File resolution + cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  mtimeMs: number;
  data: PobTreeData;
}

const treeCache = new Map<string, CacheEntry>();

/**
 * Resolve the suite root.
 *
 * `process.cwd()` is unreliable in production — the MCP server is launched
 * by Claude Code from PoB's user-builds directory, not from the suite root.
 * `import.meta.url` would be reliable but is incompatible with our CJS test
 * config (Jest+ts-jest+ESM is fragile to configure).
 *
 * Strategy: walk up from `process.argv[1]` (the entry script). In production
 * the entry is `<suite>/pob-mcp/build/index.js`, so walking up reliably finds
 * the suite. In tests the entry is the jest runner; we fall through to the
 * env-var or cwd fallback.
 *
 * Resolution order:
 *   1. POE_MCP_SUITE_ROOT env var (preferred for explicit configuration)
 *   2. Walk up from `process.argv[1]` looking for a `pob-mcp/package.json` marker
 *   3. Walk up from `process.cwd()` looking for the same marker
 *   4. Last-resort: `process.cwd()` itself (will produce a clear ENOENT)
 */
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

/**
 * PathOfBuilding submodule directory. Override with POE_MCP_SUITE_POB_DIR if
 * the submodule isn't at the canonical `<suite>/PathOfBuilding/` location.
 */
function resolvePobDir(): string {
  if (process.env.POE_MCP_SUITE_POB_DIR) return process.env.POE_MCP_SUITE_POB_DIR;
  return join(resolveSuiteRoot(), "PathOfBuilding");
}

/**
 * Find the latest tree version directory under PathOfBuilding/src/TreeData/.
 * Versions are named like `3_28`, `3_27`, etc. We pick the lexically largest.
 */
function findLatestVersion(pobDir: string): string {
  const treeDataDir = join(pobDir, "src", "TreeData");
  const entries = readdirSync(treeDataDir, { withFileTypes: true });
  const versions = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => /^\d+_\d+$/.test(n))
    .sort((a, b) => {
      const [aMaj, aMin] = a.split("_").map(Number);
      const [bMaj, bMin] = b.split("_").map(Number);
      if (aMaj !== bMaj) return bMaj - aMaj;
      return bMin - aMin;
    });
  if (versions.length === 0) {
    throw new Error(`No TreeData/X_Y/ directories found under ${treeDataDir}`);
  }
  return versions[0];
}

function treeLuaPath(version?: string): { path: string; version: string } {
  const pobDir = resolvePobDir();
  const ver = version ?? findLatestVersion(pobDir);
  return { path: join(pobDir, "src", "TreeData", ver, "tree.lua"), version: ver };
}

/**
 * Load and parse PoB's tree.lua for a given PoE version (default: latest
 * directory under PathOfBuilding/src/TreeData/). Cached in memory keyed by
 * the file's mtime; subsequent calls are O(1).
 */
export function getPobTreeData(version?: string): PobTreeData {
  const { path, version: resolvedVersion } = treeLuaPath(version);
  const stat = statSync(path);
  const cached = treeCache.get(resolvedVersion);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.data;

  const source = readFileSync(path, "utf-8");
  const ast = luaparse.parse(source, { comments: false, ranges: false });
  let rootTable: LuaNode | null = null;
  for (const stmt of (ast as { body: { type: string; arguments?: LuaNode[] }[] }).body) {
    if (stmt.type === "ReturnStatement" && stmt.arguments && stmt.arguments[0]) {
      rootTable = stmt.arguments[0];
      break;
    }
  }
  if (!rootTable) {
    throw new Error(`No return statement found in ${path}`);
  }
  const parsed = luaToJs(rootTable) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Failed to parse ${path}: top-level is not an object`);
  }

  // Normalize node entries (coerce empty Lua tables to empty arrays).
  const nodes: Record<string, PobNode> = {};
  const rawNodes = (parsed.nodes ?? {}) as Record<string, Record<string, unknown>>;
  for (const [id, node] of Object.entries(rawNodes)) {
    nodes[id] = normalizeNode(node);
  }

  const data: PobTreeData = {
    ...(parsed as PobTreeData),
    nodes,
    groups: (parsed.groups ?? {}) as Record<string, PobGroup>,
  };

  treeCache.set(resolvedVersion, { mtimeMs: stat.mtimeMs, data });
  return data;
}

/**
 * Look up a single node by ID. Returns null if not found.
 */
export function getPobNode(nodeId: string, version?: string): PobNode | null {
  const tree = getPobTreeData(version);
  return tree.nodes[nodeId] ?? null;
}

/**
 * Look up which PoE version directory we loaded from (for diagnostics).
 */
export function getLoadedVersion(version?: string): string {
  return treeLuaPath(version).version;
}
