/**
 * PoB Eldritch Implicit Data Loader
 *
 * Reads PoB community's `PathOfBuilding/src/Data/ModEldritch.lua` — the
 * Searing Exarch / Eater of Worlds implicit pools — and exposes them as typed
 * JS objects.
 *
 * Why a dedicated loader: eldritch implicits are NOT in ModExplicit.lua. They
 * live in their own table keyed by mod id, with `type = "Exarch" | "Eater"`,
 * no prefix/suffix, and a `weightKey` whose first entry is a per-item-tier
 * marker (`no_tier_6_eldritch_implicit`, always weight 0 and never matched by
 * PoB's own weight resolution) followed by the slot tags the mod can land on.
 * Treating them as ordinary explicit mods therefore yields either nothing or
 * weight-0 rows that look unrollable.
 *
 * Structure of the pool (verified against the live table on 2026-11-19):
 *   - 4086 entries = 681 families x 6 tiers
 *   - every family appears in three PRESENCE variants that share a base group
 *     name: plain, "...UniquePresence" and "...PinnaclePresence"
 *   - `tier` is the trailing number on the id (1 = lowest rolls), and the
 *     six tiers per family occupy the same mod group, so they are mutually
 *     exclusive on one item
 *   - a tier with resolved weight 0 on a slot cannot roll there (this is how
 *     the data encodes "Pinnacle variants start at tier 3", matching poewiki
 *
 * Cross-check performed when this loader was written: every (mod, slot) pair
 * listed on poewiki's two "List of ... implicit modifiers" pages is present
 * here with an identical spawn weight.
 *
 * Legal: same posture as the other loaders — we read PoB's redistributed Lua
 * under their license and never touch the game's Bundles2/ archives.
 */
import { readFileSync, statSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import luaparse from "luaparse";

export type EldritchSource = "Exarch" | "Eater";

/** Conditional variant of an implicit ("in your Presence" wording). */
export type EldritchPresence = "none" | "unique" | "pinnacle";

export interface PobEldritchMod {
  /** Table key, e.g. "AddedFireDamageEldritchImplicit3". */
  id: string;
  /** Which influence grants it. */
  source: EldritchSource;
  /** Stat text with roll ranges, e.g. "Adds (6-8) to (13-15) Fire Damage to Attacks". */
  statLines: string[];
  /** Full PoB mod group, e.g. "FireDamagePinnaclePresence". */
  group: string;
  /** Group with the presence suffix removed — the "family" the tiers belong to. */
  family: string;
  presence: EldritchPresence;
  /** 1..6 (1 = lowest roll range). Null when the id carries no number. */
  tier: number | null;
  /** Minimum item level PoB records for the entry (75 for the whole pool). */
  level: number;
  /** Item-class weights; same first-match-wins semantics as explicit mods. */
  weights: Array<{ tag: string; weight: number }>;
  modTags: string[];
}

// ---------------------------------------------------------------------------
// Lua AST -> JS object (duplicated from the sibling loaders to keep modules
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
  index?: LuaNode;
  base?: LuaNode;
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
      return raw;
    }
    case "BooleanLiteral":
      return node.value;
    case "NilLiteral":
      return null;
    case "UnaryExpression": {
      if (node.operator === "-") {
        const arg = luaToJs(node.argument);
        return typeof arg === "number" ? -arg : null;
      }
      return null;
    }
    case "TableConstructorExpression": {
      const fields = node.fields ?? [];
      const isSequence =
        fields.length > 0 && fields.every((f) => f.type === "TableValue");
      if (isSequence) return fields.map((f) => luaToJs(f.value));
      const obj: Record<string, unknown> = {};
      let implicitIndex = 1;
      for (const field of fields) {
        if (field.type === "TableKey") {
          obj[String(luaToJs(field.key as LuaNode))] = luaToJs(field.value);
        } else if (field.type === "TableKeyString") {
          obj[(field.key as { name: string }).name] = luaToJs(field.value);
        } else {
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
// Path resolution (mirrors pobModDataLoader)
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

function eldritchModPath(): string {
  const candidate = join(resolvePobDir(), "src", "Data", "ModEldritch.lua");
  if (existsSync(candidate)) return candidate;
  throw new Error(
    `PoB eldritch mod data not found at ${candidate}. ` +
      `Check the PathOfBuilding submodule is checked out (or set POE_MCP_SUITE_POB_DIR).`,
  );
}

function uniquesDir(): string {
  return join(resolvePobDir(), "src", "Data", "Uniques");
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Tags that exist in `weightKey` but are not item slots: the "default"
 * fallthrough and the per-item-tier markers (`no_tier_1_eldritch_implicit`
 * .. `no_tier_6_...`), which are always weight 0 and are never matched by a
 * base's tag chain in PoB either.
 */
const NON_SLOT_TAG = /^(default|no_tier_\d+_eldritch_implicit)$/;

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

export function isSlotTag(tag: string): boolean {
  return !NON_SLOT_TAG.test(tag);
}

function normalizeMod(id: string, raw: Record<string, unknown>): PobEldritchMod {
  const group = typeof raw.group === "string" ? raw.group : "";
  const presence: EldritchPresence = /UniquePresence$/.test(group)
    ? "unique"
    : /PinnaclePresence$/.test(group)
      ? "pinnacle"
      : "none";
  const family = group.replace(/(UniquePresence|PinnaclePresence)$/, "");
  const tierMatch = id.match(/(\d+)$/);
  const source: EldritchSource = raw.type === "Eater" ? "Eater" : "Exarch";

  const weights: Array<{ tag: string; weight: number }> = [];
  if (Array.isArray(raw.weightKey) && Array.isArray(raw.weightVal)) {
    const len = Math.min(raw.weightKey.length, raw.weightVal.length);
    for (let i = 0; i < len; i++) {
      const tag = raw.weightKey[i];
      const weight = raw.weightVal[i];
      if (typeof tag === "string" && typeof weight === "number") {
        weights.push({ tag, weight });
      }
    }
  }

  return {
    id,
    source,
    statLines: extractStatLines(raw),
    group,
    family,
    presence,
    tier: tierMatch ? Number(tierMatch[1]) : null,
    level: typeof raw.level === "number" ? raw.level : 1,
    weights,
    modTags: Array.isArray(raw.modTags) ? (raw.modTags as string[]) : [],
  };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  mtimeMs: number;
  all: PobEldritchMod[];
  byId: Map<string, PobEldritchMod>;
}

let cached: CacheEntry | null = null;

function load(): CacheEntry {
  const path = eldritchModPath();
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

  const all: PobEldritchMod[] = [];
  const byId = new Map<string, PobEldritchMod>();
  for (const [id, rawEntry] of Object.entries(parsed)) {
    if (!rawEntry || typeof rawEntry !== "object") continue;
    const mod = normalizeMod(id, rawEntry);
    all.push(mod);
    byId.set(id, mod);
  }

  cached = { mtimeMs: stat.mtimeMs, all, byId };
  return cached;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function ensureEldritchLoaded(): void {
  load();
}

export function getEldritchMod(id: string): PobEldritchMod | null {
  return load().byId.get(id) ?? null;
}

export function getEldritchModCount(): number {
  return load().all.length;
}

export function getEldritchDataPath(): string {
  return eldritchModPath();
}

/**
 * Resolve a mod's weight for a set of item tags. Mirrors PoB's
 * `ItemClass:GetModSpawnWeight`: first `weightKey` present in the tag set
 * wins; otherwise the `default` entry applies.
 */
export function resolveEldritchWeight(
  mod: PobEldritchMod,
  tags: Iterable<string>
): { weight: number; matchedTag: string } {
  const tagSet = tags instanceof Set ? tags : new Set(tags);
  for (const w of mod.weights) {
    if (isSlotTag(w.tag) && tagSet.has(w.tag)) {
      return { weight: w.weight, matchedTag: w.tag };
    }
  }
  const def = mod.weights.find((w) => w.tag === "default");
  return { weight: def ? def.weight : 0, matchedTag: "default" };
}

/** Slots where this exact mod can roll (weight > 0). */
export function slotTagsOf(mod: PobEldritchMod): string[] {
  return mod.weights.filter((w) => isSlotTag(w.tag) && w.weight > 0).map((w) => w.tag);
}

/** Every slot token that appears anywhere in the pool. */
export function getEldritchSlotTags(): string[] {
  const seen = new Set<string>();
  for (const mod of load().all) for (const tag of slotTagsOf(mod)) seen.add(tag);
  return [...seen].sort();
}

export interface EldritchSearchFilters {
  /** "Exarch" | "Eater" | "both" (default). Case-insensitive. */
  source?: string;
  /**
   * Item tag chain to resolve weights against (e.g. a base's tags). When set,
   * only mods with resolved weight > 0 on these tags are returned.
   */
  tags?: string[];
  /** Case-insensitive substring match against the stat text. */
  statContains?: string;
  /** Include the "in your Presence" variants. Default false. */
  includeConditional?: boolean;
  /** Cap the number of families returned. 0 = no cap. Default 20. */
  limitFamilies?: number;
}

export interface EldritchTierEntry {
  tier: number | null;
  id: string;
  statLines: string[];
  /** Resolved weight on the queried tags (when tags were supplied). */
  weight?: number;
}

export interface EldritchFamily {
  source: EldritchSource;
  family: string;
  presence: EldritchPresence;
  /** Slot tags every tier of this family shares (weight > 0). */
  slots: string[];
  modTags: string[];
  tiers: EldritchTierEntry[];
}

export function searchEldritchImplicits(filters: EldritchSearchFilters = {}): {
  families: EldritchFamily[];
  matchedMods: number;
  totalFamilies: number;
} {
  const wantSource = (filters.source ?? "both").toLowerCase();
  const tagSet = filters.tags ? new Set(filters.tags) : null;
  const needle = filters.statContains?.toLowerCase();
  const grouped = new Map<string, EldritchFamily>();
  let matchedMods = 0;

  for (const mod of load().all) {
    if (wantSource !== "both" && mod.source.toLowerCase() !== wantSource) continue;
    if (!filters.includeConditional && mod.presence !== "none") continue;
    if (needle) {
      const hay = mod.statLines.join(" ").toLowerCase();
      if (!hay.includes(needle)) continue;
    }
    let weight: number | undefined;
    const availableSlots = slotTagsOf(mod);
    if (tagSet) {
      const resolved = resolveEldritchWeight(mod, tagSet);
      if (resolved.weight <= 0) continue;
      weight = resolved.weight;
    } else if (availableSlots.length === 0) {
      // Entries carrying only `default` weights (or weight 0 everywhere) are
      // unreachable in game — the table stores them, nothing can roll them.
      continue;
    }
    matchedMods++;

    const key = `${mod.source}|${mod.group}`;
    let fam = grouped.get(key);
    if (!fam) {
      fam = {
        source: mod.source,
        family: mod.family,
        presence: mod.presence,
        slots: [],
        modTags: mod.modTags,
        tiers: [],
      };
      grouped.set(key, fam);
    }
    if (fam.slots.length === 0) fam.slots = availableSlots;
    fam.tiers.push({
      tier: mod.tier,
      id: mod.id,
      statLines: mod.statLines,
      weight,
    });
  }

  const families = [...grouped.values()];
  for (const f of families) {
    f.tiers.sort((a, b) => (a.tier ?? 0) - (b.tier ?? 0));
  }
  families.sort(
    (a, b) =>
      a.family.localeCompare(b.family) || a.source.localeCompare(b.source),
  );

  const limit = filters.limitFamilies ?? 20;
  return {
    families: limit > 0 ? families.slice(0, limit) : families,
    matchedMods,
    totalFamilies: families.length,
  };
}

// ---------------------------------------------------------------------------
// Eldritch-capable bases
// ---------------------------------------------------------------------------

/**
 * Item types that can take eldritch implicits. This is the rule the game and
 * poewiki state: "Eldritch implicits may only be applied to body armour,
 * boots, gloves, helmets, or the unique amulet The Eternal Struggle."
 *
 * The amulet case is why this is a whitelist of TYPES plus a scan of the
 * unique table (below) rather than "any base whose tags include a slot token":
 * the pool carries amulet weights, and resolving them against a plain Onyx
 * Amulet would happily list mods the item can never hold.
 */
export const ELDRITCH_ITEM_TYPES = [
  "Helmet",
  "Body Armour",
  "Gloves",
  "Boots",
] as const;

export interface EldritchCapableUnique {
  title: string;
  baseName: string;
  sources: EldritchSource[];
}

interface UniqueScanCache {
  mtimeSum: number;
  uniques: EldritchCapableUnique[];
}

let uniqueCache: UniqueScanCache | null = null;

/**
 * Uniques that can hold eldritch implicits, discovered from the item text
 * itself: PoB stores the flags as literal "Searing Exarch Item" /
 * "Eater of Worlds Item" lines in `Data/Uniques/*.lua`, so a new exception
 * added by GGG shows up here without a code change.
 */
export function getEldritchCapableUniques(): EldritchCapableUnique[] {
  const dir = uniquesDir();
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".lua"))
    .map((d) => d.name)
    .sort();
  let mtimeSum = 0;
  for (const f of files) mtimeSum += statSync(join(dir, f)).mtimeMs;
  if (uniqueCache && uniqueCache.mtimeSum === mtimeSum) return uniqueCache.uniques;

  const out: EldritchCapableUnique[] = [];
  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf-8");
    const blocks = text.match(/\[\[[\s\S]*?\]\]/g) ?? [];
    for (const block of blocks) {
      const hasExarch = block.includes("Searing Exarch Item");
      const hasEater = block.includes("Eater of Worlds Item");
      if (!hasExarch && !hasEater) continue;
      const lines = block
        .replace(/^\[\[|\]\]$/g, "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      const title = lines[0];
      // The base type is the first line that is not a flag/source/variant line.
      const baseName = lines.find(
        (l, i) =>
          i > 0 &&
          !/^(Searing Exarch Item|Eater of Worlds Item|Variant:|Source:|Requires Level|Implicits:)/.test(l),
      );
      if (!title || !baseName) continue;
      const sources: EldritchSource[] = [];
      if (hasExarch) sources.push("Exarch");
      if (hasEater) sources.push("Eater");
      out.push({ title, baseName, sources });
    }
  }

  uniqueCache = { mtimeSum, uniques: out };
  return out;
}
