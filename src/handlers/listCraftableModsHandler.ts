/**
 * Handler for the list_craftable_mods_for_base MCP tool.
 *
 * Given a base item name (and optional ilvl), pull every prefix and suffix
 * from PoB's ModItem.lua that can roll on that base. Group results by mod
 * group, show the highest available tier per group, and indicate which
 * tags drove the match. This is the next step beyond search_crafting_mods
 * — instead of "what mods match a stat keyword", it's "what is the entire
 * craftable space on this base right now".
 *
 * The base name lookup is case-insensitive. If the name doesn't resolve,
 * we surface up to 5 fuzzy suggestions so the user can correct it.
 */

import {
  ensureLoaded as ensureModsLoaded,
  resolveWeightForTags,
  searchMods,
  type PobMod,
} from "../services/pobModDataLoader.js";
import {
  ensureBasesLoaded,
  findBasesMatching,
  getBase,
  getBaseCount,
  type PobBase,
} from "../services/pobBaseDataLoader.js";

export interface ListCraftableModsArgs {
  base_name: string;
  ilvl?: number;
  /** "prefix" / "suffix" / undefined (both). */
  type?: string;
  /** Cap on entries per mod group (default 1 = top tier only). 0 = unlimited. */
  tiers_per_group?: number;
  /** Hide mods that only roll via influence/essence/fossil (default true). */
  hide_unrollable?: boolean;
  /** Substring filter on stat text — narrows the dump when desired. */
  stat_contains?: string;
  raw_json?: boolean;
}

interface MatchedMod {
  mod: PobMod;
  /** Resolved weight on this base. */
  weight: number;
  /** Which tag actually matched (or "default" if it fell through). */
  matchedTag: string;
}

function resolveWithTagInfo(mod: PobMod, tags: string[]): { weight: number; tag: string } {
  const tagSet = new Set(tags);
  for (const w of mod.weights) {
    if (tagSet.has(w.tag)) return { weight: w.weight, tag: w.tag };
  }
  const def = mod.weights.find((w) => w.tag === "default");
  return { weight: def ? def.weight : 0, tag: "default" };
}

/**
 * Group matched mods by their `group` field and keep the top-N tiers per
 * group (sorted by descending level — highest-tier first). Within a group,
 * if two mods share the same level (rare), declaration order is preserved.
 */
function groupAndTier(
  matches: MatchedMod[],
  tiersPerGroup: number
): Map<string, MatchedMod[]> {
  const grouped = new Map<string, MatchedMod[]>();
  for (const m of matches) {
    const key = m.mod.group || `(ungrouped:${m.mod.id})`;
    const arr = grouped.get(key) ?? [];
    arr.push(m);
    grouped.set(key, arr);
  }
  for (const [k, arr] of grouped.entries()) {
    arr.sort((a, b) => b.mod.level - a.mod.level);
    if (tiersPerGroup > 0 && arr.length > tiersPerGroup) {
      grouped.set(k, arr.slice(0, tiersPerGroup));
    }
  }
  return grouped;
}

function formatBaseHeader(base: PobBase, ilvl?: number): string[] {
  const lines: string[] = [];
  const subTypeNote = base.subType ? `, ${base.subType}` : "";
  lines.push(`=== ${base.name} (${base.type}${subTypeNote}) ===`);
  lines.push(`Tags: ${base.tags.join(", ")}`);
  if (base.implicit) lines.push(`Implicit: ${base.implicit}`);
  const reqParts: string[] = [];
  if (base.req.level !== undefined) reqParts.push(`level ${base.req.level}`);
  if (base.req.str !== undefined) reqParts.push(`str ${base.req.str}`);
  if (base.req.dex !== undefined) reqParts.push(`dex ${base.req.dex}`);
  if (base.req.int !== undefined) reqParts.push(`int ${base.req.int}`);
  if (reqParts.length > 0) lines.push(`Requirements: ${reqParts.join(", ")}`);
  if (ilvl !== undefined) lines.push(`Filtering mods to ilvl <= ${ilvl}`);
  else lines.push(`No ilvl filter — listing every tier (pass ilvl to gate).`);
  return lines;
}

function formatGroup(
  groupKey: string,
  entries: MatchedMod[]
): string[] {
  if (entries.length === 0) return [];
  const lines: string[] = [];
  const type = entries[0].mod.type;
  lines.push(`  [${type}] group "${groupKey}":`);
  for (const e of entries) {
    const tagNote =
      e.matchedTag === "default" ? " (default)" : ` (via ${e.matchedTag})`;
    const statText = e.mod.statLines.join(" / ");
    lines.push(
      `    L${e.mod.level.toString().padStart(2)} w=${e.weight.toString().padStart(4)}${tagNote}  ${e.mod.affix || "?"}: ${statText}`
    );
  }
  return lines;
}

export async function handleListCraftableModsForBase(args: ListCraftableModsArgs) {
  if (!args.base_name) {
    return {
      content: [
        {
          type: "text",
          text: "Error: base_name is required.",
        },
      ],
      isError: true,
    };
  }

  try {
    ensureBasesLoaded();
    ensureModsLoaded();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text",
          text: `Error loading PoB data: ${msg}\nEnsure the PathOfBuilding submodule is checked out.`,
        },
      ],
      isError: true,
    };
  }

  const base = getBase(args.base_name);
  if (!base) {
    const suggestions = findBasesMatching(args.base_name, 5);
    const suggestText =
      suggestions.length > 0
        ? `\nDid you mean:\n${suggestions.map((b) => `  - ${b.name} (${b.type})`).join("\n")}`
        : `\nNo close matches found. ${getBaseCount()} bases loaded.`;
    return {
      content: [
        {
          type: "text",
          text: `Base "${args.base_name}" not found.${suggestText}`,
        },
      ],
    };
  }

  const ilvl = args.ilvl;
  const typeFilter = args.type?.toLowerCase();
  const tiersPerGroup = args.tiers_per_group ?? 1;
  const hideUnrollable = args.hide_unrollable ?? true;

  // Pull every mod that matches any of the base's tags. We use the loader's
  // search with itemTags + (optional) type + statContains, then post-filter
  // for ilvl gating and unrollable-mod hiding.
  const allMatching = searchMods({
    itemTags: base.tags,
    type: typeFilter,
    statContains: args.stat_contains,
    limit: 0,
  });

  const matches: MatchedMod[] = [];
  for (const mod of allMatching) {
    if (ilvl !== undefined && mod.level > ilvl) continue;
    const { weight, tag } = resolveWithTagInfo(mod, base.tags);
    if (hideUnrollable && weight <= 0) continue;
    matches.push({ mod, weight, matchedTag: tag });
  }

  const grouped = groupAndTier(matches, tiersPerGroup);

  if (args.raw_json) {
    const json = {
      base: {
        name: base.name,
        type: base.type,
        subType: base.subType,
        tags: base.tags,
        implicit: base.implicit,
        req: base.req,
      },
      ilvl,
      filters: {
        type: typeFilter,
        stat_contains: args.stat_contains,
        tiers_per_group: tiersPerGroup,
        hide_unrollable: hideUnrollable,
      },
      mod_count: matches.length,
      group_count: grouped.size,
      groups: Array.from(grouped.entries()).map(([k, v]) => ({
        group: k,
        entries: v.map((e) => ({
          id: e.mod.id,
          type: e.mod.type,
          affix: e.mod.affix,
          level: e.mod.level,
          statLines: e.mod.statLines,
          modTags: e.mod.modTags,
          weight: e.weight,
          matchedTag: e.matchedTag,
        })),
      })),
    };
    return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
  }

  const lines: string[] = [];
  lines.push(...formatBaseHeader(base, ilvl));
  lines.push("");
  if (matches.length === 0) {
    lines.push(`No craftable mods matched (after ilvl gate + filters).`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // Split prefixes and suffixes — game presents them this way too.
  const prefixGroups: Array<[string, MatchedMod[]]> = [];
  const suffixGroups: Array<[string, MatchedMod[]]> = [];
  const otherGroups: Array<[string, MatchedMod[]]> = [];
  for (const [k, v] of grouped.entries()) {
    const type = v[0]?.mod.type.toLowerCase();
    if (type === "prefix") prefixGroups.push([k, v]);
    else if (type === "suffix") suffixGroups.push([k, v]);
    else otherGroups.push([k, v]);
  }
  // Sort groups by their top entry's level descending — most relevant first
  const sortGroups = (a: [string, MatchedMod[]], b: [string, MatchedMod[]]) =>
    (b[1][0]?.mod.level ?? 0) - (a[1][0]?.mod.level ?? 0);
  prefixGroups.sort(sortGroups);
  suffixGroups.sort(sortGroups);
  otherGroups.sort(sortGroups);

  const groupSummary = (n: number) =>
    `${n} group${n === 1 ? "" : "s"}, ${tiersPerGroup === 1 ? "top tier only" : tiersPerGroup === 0 ? "all tiers" : `up to ${tiersPerGroup} tiers each`}`;

  if (prefixGroups.length > 0) {
    lines.push(`--- PREFIXES (${groupSummary(prefixGroups.length)}) ---`);
    for (const [k, v] of prefixGroups) lines.push(...formatGroup(k, v));
    lines.push("");
  }
  if (suffixGroups.length > 0) {
    lines.push(`--- SUFFIXES (${groupSummary(suffixGroups.length)}) ---`);
    for (const [k, v] of suffixGroups) lines.push(...formatGroup(k, v));
    lines.push("");
  }
  if (otherGroups.length > 0) {
    lines.push(`--- OTHER (${groupSummary(otherGroups.length)}) ---`);
    for (const [k, v] of otherGroups) lines.push(...formatGroup(k, v));
    lines.push("");
  }
  lines.push(
    `Total mods listed: ${matches.length} across ${grouped.size} groups. ` +
      (hideUnrollable
        ? "Unrollable mods (weight 0) hidden — pass hide_unrollable=false to include essence/fossil-only entries."
        : "All matches included (incl. weight-0 essence/fossil-only mods).")
  );
  lines.push(
    "Weights shown are the spawn weight on THIS base (after tag-chain resolution). " +
      "L is the mod's minimum ilvl. Same-group mods conflict; only one can roll per item."
  );

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
