/**
 * Handlers for the bench-craft and essence query tools:
 *   - search_master_crafts  ("what can I bench-craft here?")
 *   - get_essence_detail     ("what does this essence guarantee?" /
 *                             "which essences give +Life?")
 *
 * Backed by pobCraftDataLoader (ModMaster.lua + Essence.lua). Essence mods
 * resolve through pobModDataLoader since Essence.lua stores ModItem.lua IDs.
 */

import {
  ensureCraftDataLoaded,
  findEssencesMatching,
  getEssence,
  getEssenceCount,
  getMasterCraftCount,
  resolveEssenceMods,
  searchEssencesByStat,
  searchMasterCrafts,
  type MasterCraft,
} from "../services/pobCraftDataLoader.js";

// ---------------------------------------------------------------------------
// search_master_crafts
// ---------------------------------------------------------------------------

export interface SearchMasterCraftsArgs {
  stat_contains?: string;
  item_type?: string;
  type?: string;
  has_tags?: string[];
  limit?: number;
  raw_json?: boolean;
}

function formatMasterCraft(mc: MasterCraft): string {
  const tags = mc.modTags.length > 0 ? `  {${mc.modTags.join(",")}}` : "";
  return `  [${mc.type}] "${mc.affix}" L${mc.level} group=${mc.group}${tags}\n    ${mc.statLines.join(" / ")}`;
}

export async function handleSearchMasterCrafts(args: SearchMasterCraftsArgs) {
  try {
    ensureCraftDataLoaded();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error loading PoB craft data: ${msg}` }],
      isError: true,
    };
  }

  const hasAny =
    args.stat_contains ||
    args.item_type ||
    args.type ||
    (args.has_tags && args.has_tags.length > 0);
  if (!hasAny) {
    return {
      content: [
        {
          type: "text",
          text:
            "Error: search_master_crafts requires at least one filter " +
            "(stat_contains, item_type, type, or has_tags). " +
            `${getMasterCraftCount()} bench crafts loaded.`,
        },
      ],
      isError: true,
    };
  }

  const results = searchMasterCrafts({
    statContains: args.stat_contains,
    itemType: args.item_type,
    type: args.type,
    hasTags: args.has_tags,
    limit: args.limit ?? 50,
  });

  if (args.raw_json) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              source: "PathOfBuilding/src/Data/ModMaster.lua",
              total_master_crafts: getMasterCraftCount(),
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
            `No bench crafts matched. (${getMasterCraftCount()} crafts in ModMaster.lua.)\n` +
            `Note: item_type uses PoE TYPE names ('Body Armour', 'Ring', 'One Handed Sword', ...).`,
        },
      ],
    };
  }

  const lines: string[] = [];
  lines.push(`=== Bench (master) crafts ===`);
  const filterBits: string[] = [];
  if (args.stat_contains) filterBits.push(`stat~"${args.stat_contains}"`);
  if (args.item_type) filterBits.push(`itemType=${args.item_type}`);
  if (args.type) filterBits.push(`type=${args.type}`);
  if (args.has_tags && args.has_tags.length > 0) filterBits.push(`tags=[${args.has_tags.join(",")}]`);
  lines.push(`Filters: ${filterBits.join(" ")}`);
  lines.push(`Source: ModMaster.lua (${getMasterCraftCount()} total) — ${results.length} match`);
  lines.push("");
  for (const mc of results) lines.push(formatMasterCraft(mc));
  lines.push("");
  lines.push(
    "Bench crafts are deterministic (no spawn weight, no random tier) and cost currency at the crafting bench. " +
      "Higher-level variants in the same group are stronger; only one of a group can be applied. " +
      "A bench craft occupies a prefix/suffix slot like any other mod."
  );
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// ---------------------------------------------------------------------------
// get_essence_detail
// ---------------------------------------------------------------------------

export interface GetEssenceDetailArgs {
  essence_name?: string;
  stat_contains?: string;
  item_type?: string;
  raw_json?: boolean;
}

export async function handleGetEssenceDetail(args: GetEssenceDetailArgs) {
  try {
    ensureCraftDataLoaded();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error loading PoB essence data: ${msg}` }],
      isError: true,
    };
  }

  if (!args.essence_name && !args.stat_contains) {
    return {
      content: [
        {
          type: "text",
          text:
            "Error: provide either essence_name (to see what an essence guarantees) " +
            "or stat_contains (to find essences that provide a stat). " +
            `${getEssenceCount()} essences loaded.`,
        },
      ],
      isError: true,
    };
  }

  // Mode 1: specific essence → what it guarantees per item type
  if (args.essence_name) {
    const essence = getEssence(args.essence_name);
    if (!essence) {
      const suggestions = findEssencesMatching(args.essence_name, 8);
      const text =
        suggestions.length > 0
          ? `Essence "${args.essence_name}" not found.\nDid you mean:\n${suggestions.map((e) => `  - ${e.name} (tier ${e.tier})`).join("\n")}`
          : `Essence "${args.essence_name}" not found. ${getEssenceCount()} essences loaded. Try a partial name like "Greed" or "Deafening".`;
      return { content: [{ type: "text", text }] };
    }

    const resolved = resolveEssenceMods(essence.name, args.item_type);

    if (args.raw_json) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                essence: { name: essence.name, tier: essence.tier },
                item_type_filter: args.item_type ?? null,
                guarantees: resolved.map((r) => ({
                  itemType: r.itemType,
                  modId: r.modId,
                  statLines: r.mod?.statLines ?? null,
                  type: r.mod?.type ?? null,
                  group: r.mod?.group ?? null,
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    }

    const lines: string[] = [];
    lines.push(`=== ${essence.name} (tier ${essence.tier}) ===`);
    lines.push(`Guarantees one mod per item type when used. Resolved from ModItem.lua:`);
    lines.push("");
    if (resolved.length === 0) {
      lines.push(
        args.item_type
          ? `  This essence has no entry for item type "${args.item_type}".`
          : `  (no mods listed)`
      );
    } else {
      // sort by item type alpha for stable output
      resolved.sort((a, b) => a.itemType.localeCompare(b.itemType));
      for (const r of resolved) {
        const stat = r.mod ? r.mod.statLines.join(" / ") : `(unresolved mod id ${r.modId})`;
        const meta = r.mod ? ` [${r.mod.type}]` : "";
        lines.push(`  ${r.itemType}${meta}: ${stat}`);
      }
    }
    lines.push("");
    lines.push(
      "An essence rerolls the item and guarantees the listed mod for the item's type. " +
        "Higher tiers (Deafening > Shrieking > Screaming > ...) give stronger values."
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // Mode 2: stat keyword → which essences provide it
  const matches = searchEssencesByStat(args.stat_contains!, 40);
  if (args.raw_json) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              stat_contains: args.stat_contains,
              result_count: matches.length,
              results: matches.map((m) => ({
                name: m.essence.name,
                tier: m.essence.tier,
                matchingItemTypes: m.matchingTypes,
              })),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  if (matches.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `No essences provide a mod matching "${args.stat_contains}". (${getEssenceCount()} essences searched.)`,
        },
      ],
    };
  }

  const lines: string[] = [];
  lines.push(`=== Essences providing "${args.stat_contains}" ===`);
  lines.push(`${matches.length} essence(s):`);
  lines.push("");
  for (const m of matches) {
    const types = m.matchingTypes.slice(0, 6).join(", ") + (m.matchingTypes.length > 6 ? ", ..." : "");
    lines.push(`  ${m.essence.name} (tier ${m.essence.tier}) — on: ${types}`);
  }
  lines.push("");
  lines.push(`Use get_essence_detail with essence_name="<name>" to see exact values per item type.`);
  return { content: [{ type: "text", text: lines.join("\n") }] };
}
