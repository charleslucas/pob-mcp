/**
 * Handler for the analyze_item_mods MCP tool.
 *
 * Given a set of mod lines from an item (the explicit prefix/suffix text
 * a player sees in PoE), identify each line as a specific entry in PoB's
 * ModItem.lua and surface tier info + the next-tier upgrade target.
 *
 * Adjacent lines that match the same hybrid mod (e.g. Crocodile's
 * "+to Armour" / "+to Life") are collapsed into a single 2-line mod.
 *
 * Recognised input cleaning:
 *   - Strips master-craft tags (`{crafted}`, `(crafted)`) — those mods
 *     come from ModMaster.lua, not ModItem.lua. The handler reports them
 *     separately as "crafted mod, not from natural prefix/suffix pool"
 *     rather than guessing.
 *   - Strips `{fractured}`, `{enchanted}`, `[fractured]` tags.
 *   - Skips blank lines.
 */

import {
  ensureLoaded,
  matchStatLine,
  type MatchResult,
  type PobMod,
} from "../services/pobModDataLoader.js";
import {
  ensureBasesLoaded,
  findBasesMatching,
  getBase,
  type PobBase,
} from "../services/pobBaseDataLoader.js";
import {
  ensureCraftDataLoaded,
  matchMasterCraft,
  type MasterCraft,
} from "../services/pobCraftDataLoader.js";
import type { AnyLuaClient } from "../pobLuaBridge.js";
import { parseItemRawMods, parseItemLevel } from "../utils/itemRawParser.js";

export interface AnalyzeItemModsContext {
  getLuaClient: () => AnyLuaClient | null;
  ensureLuaClient: () => Promise<void>;
}

export interface AnalyzeItemModsArgs {
  mod_lines?: string[];
  /**
   * Read the item from the live PoB build instead of mod_lines. The slot
   * name as PoB labels it ("Body Armour", "Weapon 1", "Ring 1", "Helmet",
   * etc). Requires a connected PoB TCP bridge.
   */
  item_slot?: string;
  base_name?: string;
  ilvl?: number;
  raw_json?: boolean;
}

interface LineAnalysis {
  /** 1-indexed line number from the input. */
  inputLine: number;
  /** Original line as given. */
  raw: string;
  /** Same line with crafted/fractured/etc markers stripped. */
  cleaned: string;
  /** Detected source: natural | crafted | fractured | enchanted | unknown. */
  source: "natural" | "crafted" | "fractured" | "enchanted" | "unknown";
  /** The matched mod (or null if no match found). */
  match: MatchResult | null;
  /** Matched bench craft, for `{crafted}` lines (null otherwise). */
  masterMatch?: MasterCraft | null;
  /** True if this line is the second line of a hybrid mod above it. */
  isHybridContinuation?: boolean;
}

function cleanLine(line: string): { text: string; source: LineAnalysis["source"] } {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { text: "", source: "natural" };
  let source: LineAnalysis["source"] = "natural";
  let text = trimmed;
  if (/\{crafted\}/i.test(text) || /\(crafted\)/i.test(text)) source = "crafted";
  else if (/\{fractured\}/i.test(text) || /\[fractured\]/i.test(text)) source = "fractured";
  else if (/\{enchanted\}/i.test(text)) source = "enchanted";
  text = text
    .replace(/\{crafted\}/gi, "")
    .replace(/\(crafted\)/gi, "")
    .replace(/\{fractured\}/gi, "")
    .replace(/\[fractured\]/gi, "")
    .replace(/\{enchanted\}/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return { text, source };
}

function summarizeMod(mod: PobMod): string {
  return `${mod.id} [${mod.type}] "${mod.affix || "?"}" L${mod.level} group="${mod.group || "?"}"`;
}

function tierString(r: MatchResult): string {
  if (r.tier && r.tierMax) return `tier ${r.tier}/${r.tierMax}`;
  return "tier (unknown)";
}

function nextString(r: MatchResult): string {
  if (!r.nextTier) return "(already top tier on this base)";
  return `${r.nextTier.id} "${r.nextTier.affix}" L${r.nextTier.level} → ${r.nextTier.statLines.join(" / ")}`;
}

export async function handleAnalyzeItemMods(
  args: AnalyzeItemModsArgs,
  context?: AnalyzeItemModsContext
) {
  try {
    ensureLoaded();
    ensureBasesLoaded();
    ensureCraftDataLoaded();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [
        { type: "text", text: `Error loading PoB data: ${msg}\nEnsure the PathOfBuilding submodule is checked out.` },
      ],
      isError: true,
    };
  }

  // Resolve inputs: either explicit mod_lines, or a live item slot read
  // from PoB over TCP. item_slot wins when both are present.
  let modLines = args.mod_lines ?? [];
  let resolvedBaseName = args.base_name;
  let resolvedIlvl = args.ilvl;
  let liveItemNote: string | null = null;

  if (args.item_slot) {
    if (!context) {
      return {
        content: [{ type: "text", text: "Error: item_slot requires a live PoB connection (internal context missing)." }],
        isError: true,
      };
    }
    try {
      await context.ensureLuaClient();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error connecting to PoB: ${msg}\nLaunch PoB via LaunchPoBWithAPI.bat, then retry.` }],
        isError: true,
      };
    }
    const luaClient = context.getLuaClient();
    if (!luaClient) {
      return {
        content: [{ type: "text", text: "Error: PoB Lua client not initialized — can't read the equipped item." }],
        isError: true,
      };
    }
    let items: Array<{ slot?: string; name?: string; baseName?: string; type?: string; raw?: string }>;
    try {
      items = (await luaClient.getItems()) as typeof items;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error reading equipped items: ${msg}` }],
        isError: true,
      };
    }
    const wanted = args.item_slot.toLowerCase();
    const item = items.find((it) => it.slot && it.slot.toLowerCase() === wanted && it.name);
    if (!item) {
      const occupied = items.filter((it) => it.name).map((it) => it.slot).join(", ");
      return {
        content: [{ type: "text", text: `No item found in slot "${args.item_slot}". Occupied slots: ${occupied || "(none)"}.` }],
      };
    }
    // Convert raw mods to tagged lines (only explicit/crafted/fractured —
    // implicit/enchant aren't natural prefix/suffix mods).
    const parsed = parseItemRawMods(item.raw);
    const usable = parsed.filter((m) => ["explicit", "crafted", "fractured"].includes(m.type));
    modLines = usable.map((m) => {
      if (m.type === "crafted") return `${m.line} {crafted}`;
      if (m.type === "fractured") return `${m.line} {fractured}`;
      return m.line;
    });
    // Auto-derive base + ilvl from the live item unless explicitly overridden.
    if (!resolvedBaseName && item.baseName) resolvedBaseName = item.baseName;
    if (resolvedIlvl === undefined) resolvedIlvl = parseItemLevel(item.raw);
    liveItemNote = `Read "${item.name}" from slot "${item.slot}" (${item.baseName ?? item.type ?? "?"})`;
  }

  if (!Array.isArray(modLines) || modLines.length === 0) {
    return {
      content: [
        {
          type: "text",
          text:
            "Error: provide either mod_lines (array of prefix/suffix text) or " +
            "item_slot (to read a live equipped item via PoB). " +
            "Example mod_lines: ['+150 to maximum Life', '+45% to Fire Resistance'].",
        },
      ],
      isError: true,
    };
  }

  // Resolve the base (optional) — gives us the tag chain for accurate matching.
  let base: PobBase | null = null;
  let baseSuggestions: string[] = [];
  if (resolvedBaseName) {
    base = getBase(resolvedBaseName);
    if (!base) {
      const matches = findBasesMatching(resolvedBaseName, 5);
      baseSuggestions = matches.map((b) => b.name);
    }
  }
  const itemTags = base?.tags;
  const ilvl = resolvedIlvl;

  // Per-line analysis pass
  const analyses: LineAnalysis[] = modLines.map((raw, i) => {
    const { text, source } = cleanLine(raw);
    if (text.length === 0) {
      return { inputLine: i + 1, raw, cleaned: "", source, match: null };
    }
    // Natural and fractured both come from the prefix/suffix pool.
    if (source === "natural" || source === "fractured") {
      const m = matchStatLine(text, { itemTags, ilvl });
      return { inputLine: i + 1, raw, cleaned: text, source, match: m };
    }
    // Crafted lines come from the bench (ModMaster.lua). Match against it
    // using the base's item TYPE (e.g. "Body Armour"), not the tag chain.
    if (source === "crafted") {
      const mc = matchMasterCraft(text, base?.type);
      return { inputLine: i + 1, raw, cleaned: text, source, match: null, masterMatch: mc };
    }
    // Enchanted (lab) mods aren't indexed here.
    return { inputLine: i + 1, raw, cleaned: text, source, match: null };
  });

  // Collapse hybrid mods: if line N and line N+1 both matched the same
  // mod ID, mark N+1 as a hybrid continuation. Multi-line mods (e.g.
  // life+armour, life+es) appear as two adjacent stat lines on the item
  // and would otherwise be reported twice.
  for (let i = 1; i < analyses.length; i++) {
    const a = analyses[i];
    const prev = analyses[i - 1];
    if (a.match?.best && prev.match?.best && a.match.best.id === prev.match.best.id) {
      a.isHybridContinuation = true;
    }
  }

  if (args.raw_json) {
    const json = {
      base: base
        ? { name: base.name, type: base.type, tags: base.tags, implicit: base.implicit }
        : null,
      base_suggestions: baseSuggestions,
      ilvl,
      lines: analyses.map((a) => ({
        input_line: a.inputLine,
        raw: a.raw,
        cleaned: a.cleaned,
        source: a.source,
        is_hybrid_continuation: a.isHybridContinuation ?? false,
        match: a.match
          ? {
              best: a.match.best
                ? {
                    id: a.match.best.id,
                    type: a.match.best.type,
                    affix: a.match.best.affix,
                    level: a.match.best.level,
                    group: a.match.best.group,
                    statLines: a.match.best.statLines,
                  }
                : null,
              tier: a.match.tier,
              tier_max: a.match.tierMax,
              next_tier: a.match.nextTier
                ? {
                    id: a.match.nextTier.id,
                    affix: a.match.nextTier.affix,
                    level: a.match.nextTier.level,
                    statLines: a.match.nextTier.statLines,
                  }
                : null,
              candidate_count: a.match.candidates.length,
              meaningful_candidate_count: a.match.meaningfulCandidateCount,
            }
          : null,
        master_craft: a.masterMatch
          ? {
              type: a.masterMatch.type,
              affix: a.masterMatch.affix,
              level: a.masterMatch.level,
              group: a.masterMatch.group,
              statLines: a.masterMatch.statLines,
            }
          : null,
      })),
    };
    return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
  }

  // Human-readable output
  const lines: string[] = [];
  lines.push("=== Item Mod Analysis ===");
  if (liveItemNote) lines.push(liveItemNote);
  if (base) {
    lines.push(`Base: ${base.name} (${base.type}${base.subType ? `, ${base.subType}` : ""})`);
    lines.push(`Tags used for matching: ${base.tags.join(", ")}`);
  } else if (resolvedBaseName) {
    lines.push(`Base "${resolvedBaseName}" not found — matching without tag gating.`);
    if (baseSuggestions.length > 0) {
      lines.push(`Did you mean: ${baseSuggestions.join(", ")}?`);
    }
  } else {
    lines.push(`No base supplied — matching without tag gating (accuracy reduced).`);
    lines.push(`Pass base_name (e.g. 'Astral Plate') or item_slot for precise tier ladders.`);
  }
  if (ilvl !== undefined) lines.push(`ilvl: ${ilvl}`);
  lines.push("");

  // Group prefixes and suffixes separately for output
  const prefixes: LineAnalysis[] = [];
  const suffixes: LineAnalysis[] = [];
  const other: LineAnalysis[] = [];
  for (const a of analyses) {
    if (a.cleaned === "") continue;
    if (a.isHybridContinuation) continue;
    const t = (a.match?.best?.type ?? a.masterMatch?.type)?.toLowerCase();
    if (t === "prefix") prefixes.push(a);
    else if (t === "suffix") suffixes.push(a);
    else other.push(a);
  }

  function formatOne(a: LineAnalysis): string[] {
    const out: string[] = [];
    out.push(`  Line ${a.inputLine}: ${a.raw}`);
    if (a.source !== "natural") out.push(`    Source: ${a.source}`);
    // Bench-crafted line: report the master craft if we matched one.
    if (a.source === "crafted") {
      if (a.masterMatch) {
        const mc = a.masterMatch;
        out.push(`    -> bench craft "${mc.affix}" [${mc.type}] L${mc.level} group=${mc.group} → ${mc.statLines.join(" / ")}`);
      } else {
        out.push(`    Match: (bench-craft text not found in ModMaster.lua${base ? "" : " — supply base_name to match by item type"})`);
      }
      return out;
    }
    if (!a.match || !a.match.best) {
      out.push(`    Match: (none — line text did not match any natural prefix/suffix template)`);
      return out;
    }
    const m = a.match.best;
    out.push(`    -> ${m.id} "${m.affix || "?"}" [${m.type}]  L${m.level}  group=${m.group}`);
    if (a.match.tier && a.match.tierMax) {
      out.push(`    Tier: ${a.match.tier} of ${a.match.tierMax} naturally-rollable in this group${itemTags ? " on this base" : ""}`);
    }
    if (a.match.nextTier) {
      const nt = a.match.nextTier;
      out.push(`    Next tier: ${nt.id} "${nt.affix}" L${nt.level} → ${nt.statLines.join(" / ")}`);
    } else if (a.match.best) {
      out.push(`    Next tier: (already top tier${itemTags ? " on this base" : ""})`);
    }
    if (a.match.meaningfulCandidateCount > 1) {
      out.push(`    Ambiguous: ${a.match.meaningfulCandidateCount} naturally-rollable mods fit this value; best chosen by tier + weight. Supply base_name/ilvl to narrow.`);
    }
    return out;
  }

  if (prefixes.length > 0) {
    lines.push(`--- PREFIXES (${prefixes.length}) ---`);
    for (const a of prefixes) lines.push(...formatOne(a));
    lines.push("");
  }
  if (suffixes.length > 0) {
    lines.push(`--- SUFFIXES (${suffixes.length}) ---`);
    for (const a of suffixes) lines.push(...formatOne(a));
    lines.push("");
  }
  if (other.length > 0) {
    lines.push(`--- UNCLASSIFIED (${other.length}) ---`);
    for (const a of other) lines.push(...formatOne(a));
    lines.push("");
  }

  const craftedCount = analyses.filter((a) => a.source === "crafted").length;
  const fracturedCount = analyses.filter((a) => a.source === "fractured").length;
  const enchantedCount = analyses.filter((a) => a.source === "enchanted").length;
  const hybridCount = analyses.filter((a) => a.isHybridContinuation).length;

  if (craftedCount + fracturedCount + enchantedCount + hybridCount > 0) {
    lines.push("Notes:");
    if (craftedCount > 0) lines.push(`  - ${craftedCount} bench-crafted mod(s) — matched against ModMaster.lua (the bench-craft pool, deterministic; no tiers/weights).`);
    if (fracturedCount > 0) lines.push(`  - ${fracturedCount} fractured mod(s) detected — frozen at the rolled value but otherwise from the natural pool.`);
    if (enchantedCount > 0) lines.push(`  - ${enchantedCount} enchanted mod(s) — labyrinth enchantments, not from the natural pool (not indexed).`);
    if (hybridCount > 0) lines.push(`  - ${hybridCount} hybrid-mod continuation line(s) collapsed into the mod above them.`);
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
