/**
 * Atlas Tree Data Loader
 *
 * Reads `reference_data/atlastree/data.json` (GGG's official atlas tree export,
 * mirrored in the charleslucas/poe-atlastree-export fork) plus its
 * `data_patches.json` overlay. Exposes a typed API mirroring
 * `pobTreeDataLoader.ts`.
 *
 * Why no PoB-equivalent shortcut here: PoB doesn't ship atlas tree data —
 * `PathOfBuilding/src/TreeData/` is passive-tree-only because PoB is a build
 * calculator, not a map-runner. So unlike the passive tree where we read PoB's
 * pre-rendered `tree.lua`, the atlas loader goes straight to GGG's published
 * JSON. The schema is identical structurally; we just bypass the Lua parsing
 * step.
 *
 * Variants supported (matching the GGG export repo):
 *   default            — standard atlas tree (data.json)
 *   league             — current league overlay (league.json)
 *   ruthless           — Ruthless-mode atlas (ruthless.json)
 *   ruthless-league    — Ruthless current league (ruthless-league.json)
 */

import { readFileSync, statSync, existsSync } from "fs";
import { join, dirname } from "path";

export type AtlasVariant = "default" | "league" | "ruthless" | "ruthless-league";

export interface AtlasNode {
  skill: number;
  name?: string;
  icon?: string;
  stats?: string[];
  group: number;
  orbit: number;
  orbitIndex: number;
  in?: string[];
  out?: string[];
  isNotable?: boolean;
  isKeystone?: boolean;
  isJewelSocket?: boolean;
  isMastery?: boolean;
  isAtlasWormhole?: boolean;
  ascendancyName?: string;
  flavourText?: string[];
  reminderText?: string[];
  recipe?: string[];
  [key: string]: unknown;
}

export interface AtlasGroup {
  x: number;
  y: number;
  orbits?: number[];
  nodes?: string[];
  [key: string]: unknown;
}

export interface AtlasTreeData {
  tree: string;
  nodes: Record<string, AtlasNode>;
  groups: Record<string, AtlasGroup>;
  constants?: {
    orbitRadii?: number[];
    skillsPerOrbit?: number[];
    [key: string]: unknown;
  };
  min_x?: number;
  min_y?: number;
  max_x?: number;
  max_y?: number;
  points?: unknown;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Path resolution (same approach as pobTreeDataLoader)
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

function resolveAtlasDir(): string {
  if (process.env.ATLASTREE_DIRECTORY) return process.env.ATLASTREE_DIRECTORY;
  return join(resolveSuiteRoot(), "reference_data", "atlastree");
}

function dataFileFor(variant: AtlasVariant): string {
  switch (variant) {
    case "league":
      return "league.json";
    case "ruthless":
      return "ruthless.json";
    case "ruthless-league":
      return "ruthless-league.json";
    case "default":
    default:
      return "data.json";
  }
}

// ---------------------------------------------------------------------------
// Patches overlay (same shape as the skilltree overlay)
// ---------------------------------------------------------------------------

interface PatchEntry {
  stats_add?: string[];
  stats_replace?: string[];
  name_replace?: string;
  flags_set?: Record<string, boolean | string | null>;
  verified_from?: string;
  verified_date?: string;
  verified_by?: string;
  note?: string;
}

function applyPatchesToNode(node: AtlasNode, patch: PatchEntry): void {
  if (patch.stats_add) {
    node.stats = [...(node.stats ?? []), ...patch.stats_add];
  }
  if (patch.stats_replace) {
    node.stats = [...patch.stats_replace];
  }
  if (patch.name_replace !== undefined) {
    node.name = patch.name_replace;
  }
  if (patch.flags_set) {
    for (const [flag, value] of Object.entries(patch.flags_set)) {
      (node as Record<string, unknown>)[flag] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Cache + loader
// ---------------------------------------------------------------------------

interface CacheEntry {
  dataMtimeMs: number;
  patchesMtimeMs: number;
  data: AtlasTreeData;
}

const atlasCache = new Map<AtlasVariant, CacheEntry>();

export function getAtlasTreeData(variant: AtlasVariant = "default"): AtlasTreeData {
  const dir = resolveAtlasDir();
  const dataPath = join(dir, dataFileFor(variant));
  const patchesPath = join(dir, "data_patches.json");

  const dataStat = statSync(dataPath);
  const patchesMtime = existsSync(patchesPath) ? statSync(patchesPath).mtimeMs : 0;

  const cached = atlasCache.get(variant);
  if (
    cached &&
    cached.dataMtimeMs === dataStat.mtimeMs &&
    cached.patchesMtimeMs === patchesMtime
  ) {
    return cached.data;
  }

  const raw = readFileSync(dataPath, "utf-8");
  const data = JSON.parse(raw) as AtlasTreeData;

  // Apply patches overlay if present. Atlas patches are expected to be rare —
  // the data is much more stable than passive tree data — but the
  // infrastructure is here for parity.
  if (existsSync(patchesPath)) {
    try {
      const patchesRaw = readFileSync(patchesPath, "utf-8");
      const patches = JSON.parse(patchesRaw) as Record<string, PatchEntry>;
      for (const [nodeId, patch] of Object.entries(patches)) {
        const node = data.nodes[nodeId];
        if (node) applyPatchesToNode(node, patch);
      }
    } catch {
      // Bad/missing patches file shouldn't kill the loader.
    }
  }

  atlasCache.set(variant, {
    dataMtimeMs: dataStat.mtimeMs,
    patchesMtimeMs: patchesMtime,
    data,
  });
  return data;
}

export function getAtlasNode(nodeId: string, variant: AtlasVariant = "default"): AtlasNode | null {
  const tree = getAtlasTreeData(variant);
  return tree.nodes[nodeId] ?? null;
}

export function getAtlasVariantInfo(variant: AtlasVariant = "default"): { path: string; exists: boolean } {
  const path = join(resolveAtlasDir(), dataFileFor(variant));
  return { path, exists: existsSync(path) };
}
