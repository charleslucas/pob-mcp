/**
 * PoB Mod Data Loader
 *
 * Reads PoB community's `PathOfBuilding/src/Data/ModItem.lua` — PoB's parsed
 * mirror of GGG's rare/magic item mod table — and exposes it as typed JS
 * objects. The data covers every prefix/suffix that can roll on equipment
 * (rings, amulets, body armour, weapons, etc.) including essences,
 * fossil-only mods, and influence/synthesis mods.
 *
 * Same parse-once-cache pattern as pobTreeDataLoader. Auto-reloads when the
 * underlying file mtime changes (post submodule update).
 *
 * Legal: same posture as the tree loader. PoB redistributes this as a parsed
 * lua table under their own (MIT-compatible) license; the structure mirrors
 * what GGG publishes in their own data files. We don't extract from the
 * game's `Bundles2/` — we just read PoB's distributed `Data/ModItem.lua`.
 */
import { readFileSync, statSync, existsSync } from "fs";
import { join, dirname } from "path";
import luaparse from "luaparse";

export interface PobMod {
  /** Stable ID from PoB's table, e.g. "Strength1", "IncreasedLife12". */
  id: string;
  /** "Prefix" or "Suffix" (rarely other values). */
  type: string;
  /** Display name, e.g. "of the Brute", "Vigorous". */
  affix: string;
  /** Stat text lines exactly as PoB stores them, e.g. "+(8-12) to Strength". */
  statLines: string[];
  /** Internal stat ordering hint from PoB. Useful for grouping multi-stat mods. */
  statOrder?: number[];
  /** Minimum item level required for this mod to roll. */
  level: number;
  /**
   * Mod-group key. Two mods in the same group cannot roll on the same item
   * — they conflict. E.g. all "Strength1..Strength10" share group "Strength".
   */
  group: string;
  /**
   * Item-class weights. Each entry is { tag, weight }: the tag matches a
   * base-item tag (e.g. "ring", "body_armour", "bow"), the weight is the
   * spawn weight on that tag. The "default" entry is the fallthrough
   * for any tag not explicitly listed.
   *
   * Resolution (per PoE's mod-rolling logic): walk the list in order; the
   * first matching entry wins. If the target tag isn't listed at all,
   * the "default" entry applies. So `default = 0` means "cannot roll on
   * anything not otherwise listed", `default = 1000` means "rolls on
   * everything not otherwise excluded". Use `resolveWeightForTag` below
   * to do this correctly.
   */
  weights: Array<{ tag: string; weight: number }>;
  /** Free-form tag list, e.g. ["attribute"], ["resource", "life"], ["damage", "fire"]. */
  modTags: string[];
}

export type ModSource = "pob-modItem-lua";

// ---------------------------------------------------------------------------
// Lua AST -> JS object (duplicated from pobTreeDataLoader to keep modules
// independent; same algorithm)
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

// ---------------------------------------------------------------------------
// Path resolution (mirrors pobTreeDataLoader)
// ---------------------------------------------------------------------------

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

function resolvePobDir(): string {
  if (process.env.POE_MCP_SUITE_POB_DIR) return process.env.POE_MCP_SUITE_POB_DIR;
  return join(resolveSuiteRoot(), "PathOfBuilding");
}

function modItemPath(): string {
  return join(resolvePobDir(), "src", "Data", "ModItem.lua");
}

// ---------------------------------------------------------------------------
// Cache + normalization
// ---------------------------------------------------------------------------

interface CacheEntry {
  mtimeMs: number;
  mods: Record<string, PobMod>;
  byGroup: Map<string, PobMod[]>;
  byTag: Map<string, PobMod[]>;
}

let cached: CacheEntry | null = null;

/**
 * Extract stat lines (the implicit-index entries that luaToJs gave
 * numeric-string keys to) and return them in their original order.
 */
function extractStatLines(raw: Record<string, unknown>): string[] {
  const lines: string[] = [];
  let i = 1;
  while (raw[String(i)] !== undefined) {
    const v = raw[String(i)];
    if (typeof v === "string") lines.push(v);
    i++;
  }
  return lines;
}

function zipWeights(
  keys: unknown,
  vals: unknown
): Array<{ tag: string; weight: number }> {
  if (!Array.isArray(keys) || !Array.isArray(vals)) return [];
  const out: Array<{ tag: string; weight: number }> = [];
  const len = Math.min(keys.length, vals.length);
  for (let i = 0; i < len; i++) {
    const tag = keys[i];
    const weight = vals[i];
    if (typeof tag === "string" && typeof weight === "number") {
      out.push({ tag, weight });
    }
  }
  return out;
}

function normalizeMod(id: string, raw: Record<string, unknown>): PobMod {
  const statLines = extractStatLines(raw);
  const weights = zipWeights(raw.weightKey, raw.weightVal);
  const modTags = Array.isArray(raw.modTags) ? (raw.modTags as string[]) : [];
  const statOrder = Array.isArray(raw.statOrder) ? (raw.statOrder as number[]) : undefined;
  return {
    id,
    type: typeof raw.type === "string" ? raw.type : "",
    affix: typeof raw.affix === "string" ? raw.affix : "",
    statLines,
    statOrder,
    level: typeof raw.level === "number" ? raw.level : 1,
    group: typeof raw.group === "string" ? raw.group : "",
    weights,
    modTags,
  };
}

function load(): CacheEntry {
  const path = modItemPath();
  const stat = statSync(path);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached;

  const source = readFileSync(path, "utf-8");
  const ast = luaparse.parse(source, { comments: false, ranges: false });
  let rootTable: LuaNode | null = null;
  for (const stmt of (ast as { body: { type: string; arguments?: LuaNode[] }[] }).body) {
    if (stmt.type === "ReturnStatement" && stmt.arguments && stmt.arguments[0]) {
      rootTable = stmt.arguments[0];
      break;
    }
  }
  if (!rootTable) throw new Error(`No return statement found in ${path}`);
  const parsed = luaToJs(rootTable) as Record<string, Record<string, unknown>>;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Failed to parse ${path}: top-level is not an object`);
  }

  const mods: Record<string, PobMod> = {};
  const byGroup = new Map<string, PobMod[]>();
  const byTag = new Map<string, PobMod[]>();
  for (const [id, rawEntry] of Object.entries(parsed)) {
    const mod = normalizeMod(id, rawEntry);
    mods[id] = mod;
    if (mod.group) {
      const arr = byGroup.get(mod.group) ?? [];
      arr.push(mod);
      byGroup.set(mod.group, arr);
    }
    for (const tag of mod.modTags) {
      const arr = byTag.get(tag) ?? [];
      arr.push(mod);
      byTag.set(tag, arr);
    }
  }

  cached = { mtimeMs: stat.mtimeMs, mods, byGroup, byTag };
  return cached;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ModSearchFilters {
  /** Substring (case-insensitive) match against any stat line. */
  statContains?: string;
  /**
   * Restrict to mods that can roll on an item carrying these tags.
   * Pass the full tag list for accurate matching — e.g. an Astral Plate
   * is `["body_armour", "armour", "str_armour"]`. The first weight entry
   * matching ANY of these tags wins; if none match, the mod's `default`
   * weight is used. A mod is included only when the resolved weight > 0.
   */
  itemTags?: string[];
  /** "prefix" / "suffix" / etc — case-insensitive. */
  type?: string;
  /** Minimum mod-level (rolling ilvl). */
  minLevel?: number;
  /** Maximum mod-level. */
  maxLevel?: number;
  /** Filter to a specific mod group (e.g. "IncreasedLife"). */
  group?: string;
  /** Mod must include ALL of these tags. */
  hasTags?: string[];
  /** Substring (case-insensitive) match against the affix name. */
  affixContains?: string;
  /** Cap results. Default 50. Pass 0 to disable. */
  limit?: number;
}

/**
 * Force-load (or refresh) the mod data. Useful for diagnostics or to bypass
 * lazy-loading.
 */
export function ensureLoaded(): void {
  load();
}

/**
 * Get a single mod entry by ID. Returns null if not found.
 */
export function getMod(id: string): PobMod | null {
  const c = load();
  return c.mods[id] ?? null;
}

/**
 * List all mods in a given mod group (conflicting mods on the same item).
 */
export function getModGroup(group: string): PobMod[] {
  return load().byGroup.get(group) ?? [];
}

/**
 * Total number of mod entries loaded. Diagnostic.
 */
export function getModCount(): number {
  return Object.keys(load().mods).length;
}

/**
 * Search mods with combinable filters. Returns mods in PoB's original order
 * (which is roughly: by group, then by level).
 *
 * Notes:
 *   - statContains and affixContains are case-insensitive substring matches.
 *   - itemTag filtering uses the first non-zero matching weight entry. This
 *     mirrors PoE's mod-rolling logic but isn't a perfect simulation —
 *     base-tag inheritance (e.g. "two_hand_sword" inheriting from "sword")
 *     is not yet modeled here.
 *   - All filters are AND-combined.
 */
export function searchMods(filters: ModSearchFilters): PobMod[] {
  const c = load();
  const all = Object.values(c.mods);
  const stat = filters.statContains?.toLowerCase();
  const affix = filters.affixContains?.toLowerCase();
  const type = filters.type?.toLowerCase();
  const tags = filters.itemTags && filters.itemTags.length > 0 ? filters.itemTags : null;
  const minLevel = filters.minLevel ?? 0;
  const maxLevel = filters.maxLevel ?? Number.POSITIVE_INFINITY;
  const group = filters.group;
  const hasTags = filters.hasTags ?? [];
  const limit = filters.limit === undefined ? 50 : filters.limit;

  const out: PobMod[] = [];
  for (const mod of all) {
    if (type && mod.type.toLowerCase() !== type) continue;
    if (group && mod.group !== group) continue;
    if (mod.level < minLevel || mod.level > maxLevel) continue;
    if (stat && !mod.statLines.some((s) => s.toLowerCase().includes(stat))) continue;
    if (affix && !mod.affix.toLowerCase().includes(affix)) continue;
    if (tags) {
      if (resolveWeightForTags(mod, tags) <= 0) continue;
    }
    if (hasTags.length > 0) {
      if (!hasTags.every((t) => mod.modTags.includes(t))) continue;
    }
    out.push(mod);
    if (limit > 0 && out.length >= limit) break;
  }
  return out;
}

export function getModItemPath(): string {
  return modItemPath();
}

/**
 * Resolve the effective spawn weight for a mod on a given item-class tag,
 * mirroring PoE's mod-rolling logic: first matching entry in `weights`
 * wins; if no entry matches, fall back to the `default` entry; if there's
 * no default either, the mod is unrollable (weight 0).
 *
 * Returns the weight number — caller decides whether > 0 means "can roll".
 */
export function resolveWeightForTag(mod: PobMod, tag: string): number {
  return resolveWeightForTags(mod, [tag]);
}

/**
 * Like resolveWeightForTag but accepts an array of tags (representing all
 * tags a base item carries). The first entry in the mod's `weights` whose
 * tag is in the provided list wins. This matches PoE's actual rolling
 * logic: a base like Astral Plate has tags ["body_armour","armour",
 * "str_armour"], and the mod's weights are walked in order until one
 * matches any of those.
 */
export function resolveWeightForTags(mod: PobMod, tags: string[]): number {
  const tagSet = new Set(tags);
  for (const w of mod.weights) {
    if (tagSet.has(w.tag)) return w.weight;
  }
  const def = mod.weights.find((w) => w.tag === "default");
  return def ? def.weight : 0;
}
