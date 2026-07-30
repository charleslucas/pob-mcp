/**
 * Handler for the search_crafting_mods MCP tool.
 *
 * Searches PoB's mod table (ModItem.lua) for prefixes/suffixes that match
 * combined filters: stat-text keyword, item-class tag, prefix/suffix type,
 * ilvl range, mod-group, tag list. Returns the actual mod entries with
 * roll ranges, weights, group, and tags — concrete numbers, not generic
 * crafting advice.
 *
 * Counterpart to `suggest_crafting` (which gives strategic advice based on
 * poedb HTML). Use this when you want "what mods actually exist that match
 * X, and what's the spawn weight?" — for ranking targets, planning fossil
 * weight effects, or just answering "is this affix even possible on a ring?"
 */

import {
  ensureLoaded,
  getModCount,
  getModItemPath,
  resolveWeightForTags,
  searchMods,
  type ModSearchFilters,
  type PobMod,
} from "../services/pobModDataLoader.js";

/**
 * Report the mod file we ACTUALLY read. PoB split ModItem.lua into per-category files, so
 * hardcoding the old name told users their data came from a file that no longer exists.
 */
function modSourceLabel(): string {
  const p = getModItemPath().replace(/\\/g, "/");
  const idx = p.lastIndexOf("/src/Data/");
  return idx >= 0 ? `PathOfBuilding${p.slice(idx)}` : p;
}

function formatWeights(weights: PobMod["weights"]): string {
  const explicit = weights.filter((w) => w.tag !== "default" && w.weight > 0);
  const def = weights.find((w) => w.tag === "default");
  const parts: string[] = explicit.map((w) => `${w.tag}=${w.weight}`);
  if (def) parts.push(`default=${def.weight}`);
  return parts.length > 0 ? parts.join(", ") : "(none)";
}

function formatMod(m: PobMod, queriedTags?: string[]): string {
  const lines: string[] = [];
  lines.push(
    `[${m.type}] ${m.affix || "(no affix name)"} (${m.id}) — group "${m.group || "?"}", level ${m.level}`
  );
  for (const s of m.statLines) lines.push(`  ${s}`);
  if (m.modTags.length > 0) lines.push(`  Tags: ${m.modTags.join(", ")}`);
  if (queriedTags && queriedTags.length > 0) {
    const resolved = resolveWeightForTags(m, queriedTags);
    const tagSet = new Set(queriedTags);
    const matched = m.weights.find((w) => tagSet.has(w.tag));
    const note = matched ? ` (matched on tag "${matched.tag}")` : " (from default)";
    lines.push(`  Weight for queried tags: ${resolved}${note}`);
  }
  lines.push(`  All weights: ${formatWeights(m.weights)}`);
  return lines.join("\n");
}

export interface CraftingModSearchArgs {
  stat_contains?: string;
  item_tags?: string[];
  type?: string;
  min_level?: number;
  max_level?: number;
  group?: string;
  has_tags?: string[];
  affix_contains?: string;
  limit?: number;
  raw_json?: boolean;
}

export async function handleSearchCraftingMods(args: CraftingModSearchArgs) {
  try {
    ensureLoaded();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text",
          text:
            `Error loading PoB mod data from ${getModItemPath()}: ${msg}\n\n` +
            `This tool reads from the PathOfBuilding submodule — ensure it's checked out.`,
        },
      ],
      isError: true,
    };
  }

  // No filters at all → too noisy; require at least one search axis.
  const hasAny =
    args.stat_contains ||
    (args.item_tags && args.item_tags.length > 0) ||
    args.type ||
    args.min_level !== undefined ||
    args.max_level !== undefined ||
    args.group ||
    (args.has_tags && args.has_tags.length > 0) ||
    args.affix_contains;
  if (!hasAny) {
    return {
      content: [
        {
          type: "text",
          text:
            "Error: search_crafting_mods requires at least one filter " +
            "(stat_contains, item_tags, type, min_level, max_level, group, " +
            "has_tags, or affix_contains). The mod table has thousands of " +
            "entries — pick a filter to keep results useful.",
        },
      ],
      isError: true,
    };
  }

  const filters: ModSearchFilters = {
    statContains: args.stat_contains,
    itemTags: args.item_tags,
    type: args.type,
    minLevel: args.min_level,
    maxLevel: args.max_level,
    group: args.group,
    hasTags: args.has_tags,
    affixContains: args.affix_contains,
    limit: args.limit ?? 50,
  };

  const results = searchMods(filters);

  if (args.raw_json) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              source: modSourceLabel(),
              total_mods_in_table: getModCount(),
              filters,
              result_count: results.length,
              results,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  if (results.length === 0) {
    return {
      content: [
        {
          type: "text",
          text:
            `No mods matched. (Searched ${getModCount()} entries from PoB's ${modSourceLabel()}.)\n\n` +
            `Tip: stat_contains is a substring match. Try fewer words — e.g. "Life" instead of "to maximum Life", "Fire" instead of "to Fire Resistance".`,
        },
      ],
    };
  }

  const lines: string[] = [];
  const filterParts: string[] = [];
  if (filters.statContains) filterParts.push(`stat~"${filters.statContains}"`);
  if (filters.itemTags && filters.itemTags.length > 0)
    filterParts.push(`itemTags=[${filters.itemTags.join(",")}]`);
  if (filters.type) filterParts.push(`type=${filters.type}`);
  if (filters.minLevel !== undefined) filterParts.push(`level>=${filters.minLevel}`);
  if (filters.maxLevel !== undefined) filterParts.push(`level<=${filters.maxLevel}`);
  if (filters.group) filterParts.push(`group=${filters.group}`);
  if (filters.hasTags && filters.hasTags.length > 0)
    filterParts.push(`tags=[${filters.hasTags.join(",")}]`);
  if (filters.affixContains) filterParts.push(`affix~"${filters.affixContains}"`);

  lines.push(`=== Crafting mod search: ${filterParts.join(" ")} ===`);
  lines.push(`Source: ${modSourceLabel()} (${getModCount()} mods total)`);
  lines.push(
    `Result: ${results.length}${
      filters.limit && filters.limit > 0 && results.length === filters.limit
        ? ` (capped at limit ${filters.limit} — refine filters for more)`
        : ""
    }`
  );
  lines.push("");
  for (const m of results) {
    lines.push(formatMod(m, filters.itemTags));
    lines.push("");
  }
  lines.push(
    "Notes: `level` is the minimum ITEM level needed to roll the mod. Mods in the " +
      "same `group` conflict — only one can roll per item. Weights are PoE's " +
      "spawn weights; a base item picks one mod proportional to weight (after " +
      "applying influence/essence/fossil biases)."
  );

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
