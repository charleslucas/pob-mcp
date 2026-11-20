/**
 * Handler for the search_eldritch_implicits MCP tool.
 *
 * Answers "which Eldritch implicit can I put on this slot, and what are the
 * tier roll ranges?" from PoB's own `Data/ModEldritch.lua` pool — the same
 * table the "Add implicit" picker in the Items tab is built from.
 *
 * Why this needed its own tool: the pool is invisible to the explicit-mod
 * tools (`search_crafting_mods` / `find_affix_tiers` read ModExplicit, which
 * holds no eldritch rows), and the mods carry no prefix/suffix, so the usual
 * "affix ladder" framing does not apply. What matters instead is:
 *   - which of the two influences (Searing Exarch / Eater of Worlds) grants it
 *   - which slots it can land on (the pool carries weights for five slots)
 *   - the six tier roll ranges, and which of those six can actually roll
 *     (a weight-0 tier is a phantom: the data carries it, the game cannot)
 *   - the conditional "in your Presence" variants, which are separate mods
 *
 * Slot legality is enforced here rather than in the loader, because the pool
 * alone is misleading: it has amulet weights, but only the unique amulet The
 * Eternal Struggle can hold eldritch implicits (poewiki, both list pages).
 */

import {
  ELDRITCH_ITEM_TYPES,
  ensureEldritchLoaded,
  getEldritchCapableUniques,
  getEldritchDataPath,
  getEldritchModCount,
  getEldritchSlotTags,
  searchEldritchImplicits,
  type EldritchFamily,
} from "../services/pobEldritchDataLoader.js";
import {
  ensureBasesLoaded,
  findBasesMatching,
  getBase,
  type PobBase,
} from "../services/pobBaseDataLoader.js";

export interface SearchEldritchImplicitsArgs {
  base_name?: string;
  item_type?: string;
  source?: string;
  stat_contains?: string;
  include_conditional?: boolean;
  max_results?: number;
  raw_json?: boolean;
}

const TYPE_TO_SLOT_TAG: Record<string, string> = {
  helmet: "helmet",
  "body armour": "body_armour",
  "body armour ": "body_armour",
  body_armour: "body_armour",
  gloves: "gloves",
  boots: "boots",
  amulet: "amulet",
};

const SLOT_TAG_TO_LABEL: Record<string, string> = {
  helmet: "Helmet",
  body_armour: "Body Armour",
  gloves: "Gloves",
  boots: "Boots",
  amulet: "Amulet",
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function sourceLabel(source?: string): string {
  const s = (source ?? "both").toLowerCase();
  if (s === "exarch" || s === "searing" || s === "searing exarch") return "Searing Exarch";
  if (s === "eater" || s === "eater of worlds") return "Eater of Worlds";
  return "Searing Exarch + Eater of Worlds";
}

function err(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }], isError: true };
}

function ok(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }] };
}

function formatFamily(f: EldritchFamily): string[] {
  const lines: string[] = [];
  const slotText = f.slots.length > 0 ? f.slots.map((s) => SLOT_TAG_TO_LABEL[s] ?? s).join(", ") : "(no slot)";
  const tags = f.modTags.length > 0 ? `  tags: ${f.modTags.join(", ")}` : "";
  const presence =
    f.presence === "unique"
      ? "  (unique presence)"
      : f.presence === "pinnacle"
        ? "  (pinnacle presence)"
        : "";
  lines.push(`--- ${f.source} · ${f.family}${presence}  [${slotText}]${tags} ---`);
  for (const t of f.tiers) {
    const tierLabel = t.tier === null ? "T?" : `T${t.tier}`;
    const weightText = t.weight !== undefined ? ` w=${t.weight}` : "";
    lines.push(`  ${tierLabel.padEnd(3)}${weightText.padEnd(9)} ${t.statLines.join(" / ")}`);
  }
  return lines;
}

export async function handleSearchEldritchImplicits(args: SearchEldritchImplicitsArgs) {
  try {
    ensureEldritchLoaded();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`Error loading PoB eldritch data: ${msg}\nEnsure the PathOfBuilding submodule is checked out.`);
  }

  const baseNameArg = args.base_name?.trim();
  const typeArg = args.item_type?.trim();
  const statContains = args.stat_contains?.trim();

  if (!baseNameArg && !typeArg && !statContains) {
    return err(
      "Error: pass at least one of base_name (e.g. 'Hubris Circlet'), item_type " +
        "('Helmet' | 'Body Armour' | 'Gloves' | 'Boots'), or stat_contains " +
        "(e.g. 'chaos resistance'). Without a filter the pool is 681 families.",
    );
  }

  let tags: string[] | undefined;
  let label = "";
  const header: string[] = [];
  let amuletCaveat = false;
  let matchedUnique: string | undefined;

  if (baseNameArg) {
    try {
      ensureBasesLoaded();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(`Error loading PoB base data: ${msg}`);
    }

    const capableUniques = getEldritchCapableUniques();
    let base: PobBase | null = getBase(baseNameArg);
    let viaUnique: string | undefined;

    if (!base) {
      // Allow the unique's own name (e.g. "The Eternal Struggle"), whose base
      // is the thing that carries the tags.
      const unique = capableUniques.find(
        (u) => u.title.toLowerCase() === baseNameArg.toLowerCase(),
      );
      if (unique) {
        base = getBase(unique.baseName);
        viaUnique = unique.title;
      }
    }

    if (!base) {
      const suggestions = findBasesMatching(baseNameArg, 5);
      const suggestText =
        suggestions.length > 0
          ? `\nDid you mean:\n${suggestions.map((b) => `  - ${b.name} (${b.type})`).join("\n")}`
          : "";
      const uniqueHint =
        capableUniques.length > 0
          ? `\nUniques that can hold eldritch implicits: ${capableUniques.map((u) => u.title).join(", ")}.`
          : "";
      return err(`Base "${baseNameArg}" not found.${suggestText}${uniqueHint}`);
    }

    const typeOk = (ELDRITCH_ITEM_TYPES as readonly string[]).includes(base.type);
    if (!typeOk) {
      const uniqueForBase = capableUniques.find(
        (u) => u.baseName.toLowerCase() === base!.name.toLowerCase(),
      );
      if (uniqueForBase) {
        amuletCaveat = true;
        matchedUnique = uniqueForBase.title;
      } else {
        return err(
          `"${base.name}" is a ${base.type || "non-armour item"}. Eldritch implicits can only be ` +
            `applied to ${ELDRITCH_ITEM_TYPES.join(", ")}, or to the unique amulet ` +
            `${capableUniques.map((u) => u.title).join(", ") || "(none found)"}.`,
        );
      }
    }

    tags = base.tags;
    label = viaUnique ? `${viaUnique} (${base.name})` : base.name;
    const sub = base.subType ? `, ${base.subType}` : "";
    header.push(`Base: ${base.name} (${base.type}${sub})`);
    if (viaUnique) header.push(`Unique: ${viaUnique} — one of the few non-armour items that can hold eldritch implicits.`);
    header.push(`Tags: ${base.tags.join(", ")}`);
  } else if (typeArg) {
    const slotTag = TYPE_TO_SLOT_TAG[typeArg.toLowerCase()] ?? TYPE_TO_SLOT_TAG[typeArg.toLowerCase().replace(/\s+/g, " ")];
    if (!slotTag) {
      return err(
        `Unknown item_type "${typeArg}". Use one of: ${ELDRITCH_ITEM_TYPES.join(", ")} (amulet works only through The Eternal Struggle).`,
      );
    }
    // A base-tag chain always carries "default"; the slot token drives the
    // first-match weight resolution.
    tags = [slotTag, "default"];
    label = SLOT_TAG_TO_LABEL[slotTag] ?? slotTag;
    header.push(`Slot: ${label} (no specific base — pass base_name to resolve a base's tag chain)`);
    if (slotTag === "amulet") {
      amuletCaveat = true;
      const capableUniques = getEldritchCapableUniques();
      matchedUnique = capableUniques.map((u) => u.title).join(", ") || undefined;
    }
  }

  const source = (args.source ?? "both").toLowerCase();
  const result = searchEldritchImplicits({
    source,
    tags,
    statContains: statContains,
    includeConditional: args.include_conditional ?? false,
    limitFamilies: args.max_results ?? 20,
  });

  if (args.raw_json) {
    return ok(
      JSON.stringify(
        {
          source: getEldritchDataPath().replace(/\\/g, "/"),
          pool_size: getEldritchModCount(),
          slot_tags_in_pool: getEldritchSlotTags(),
          filters: {
            base_name: baseNameArg ?? null,
            item_type: typeArg ?? null,
            source,
            stat_contains: statContains ?? null,
            include_conditional: args.include_conditional ?? false,
          },
          family_count: result.totalFamilies,
          matched_mods: result.matchedMods,
          families: result.families,
        },
        null,
        2,
      ),
    );
  }

  const lines: string[] = [];
  lines.push(`=== Eldritch implicits — ${label || "all slots"} ===`);
  lines.push(...header);
  lines.push(`Influence: ${sourceLabel(source)}`);
  lines.push(`Tiers: up to 6 per family, 1 = lowest rolls, 6 = highest. Weight-0 tiers are hidden (cannot roll).`);
  if (!args.include_conditional) {
    lines.push(
      `Conditional variants (Unique / Pinnacle Atlas Boss presence) are hidden — pass include_conditional=true.`,
    );
  }
  lines.push("");

  if (result.families.length === 0) {
    lines.push("No eldritch implicit matched the filters.");
    if (tags) {
      lines.push(
        `Nothing in the ${sourceLabel(source)} pool for these tags. ` +
          `Pool slots: ${getEldritchSlotTags().join(", ")}.`,
      );
    }
    return ok(lines.join("\n"));
  }

  for (const fam of result.families) {
    lines.push(...formatFamily(fam));
    lines.push("");
  }

  if (result.totalFamilies > result.families.length) {
    lines.push(
      `Showing ${result.families.length} of ${result.totalFamilies} families ` +
        `(${result.matchedMods} tier entries). Narrow with stat_contains or raise max_results.`,
    );
    lines.push("");
  }

  lines.push("Notes:");
  lines.push(
    "  - Eldritch implicits may only be applied to body armour, boots, gloves, helmets, " +
      "or the unique amulet The Eternal Struggle (poewiki, both implicit-list pages).",
  );
  if (amuletCaveat) {
    lines.push(
      `  - Amulet rows therefore apply ONLY to ${matchedUnique ?? "The Eternal Struggle"} — ` +
        `no other amulet base can hold them, even though the pool carries amulet weights.`,
    );
  }
  lines.push(
    "  - Searing Exarch implicits come from Eldritch Embers (red), Eater of Worlds from " +
      "Eldritch Ichors (blue); Orb of Conflict reaches the top 1-2 tiers (poewiki).",
  );
  lines.push(
    "  - 'w' is the spawn weight for the slot: higher means a better chance when the implicit " +
      "rolls. Tiers of one family share a mod group, so only one of them can sit on an item.",
  );
  lines.push("  - Source: PathOfBuilding/src/Data/ModEldritch.lua (patch-current, read locally).");

  return ok(lines.join("\n"));
}
