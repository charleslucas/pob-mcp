/**
 * Handler for the get_stat_breakdown MCP tool.
 *
 * Calls the live PoB `get_stat_breakdown` Lua action, which tabulates every
 * modifier contributing to a stat (with its source), then makes the raw
 * source strings human-readable — notably resolving "Tree:<nodeId>" into the
 * passive node's name via the tree-data loader.
 *
 * This answers "WHY is my <stat> the value it is — what's contributing and
 * from where?" instead of just "what is my <stat>". Most accurate for
 * unconditional stats (Life, resistances, attributes, Armour/Evasion/ES,
 * regen). Damage and skill-conditional stats are incomplete because the
 * underlying Tabulate uses a nil config (no active-skill context).
 */

import type { AnyLuaClient } from "../pobLuaBridge.js";
import { getPobNode } from "../services/pobTreeDataLoader.js";

export interface StatBreakdownContext {
  getLuaClient: () => AnyLuaClient | null;
  ensureLuaClient: () => Promise<void>;
}

interface Contribution {
  modType: string;
  value: number | boolean | string;
  source: string;
  name: string;
  flags: number;
}

interface BreakdownResult {
  stat: string;
  actor: string;
  output_value?: number | null;
  contributions: Contribution[];
}

/**
 * Make a PoB mod `source` string readable. Known shapes:
 *   "Tree:12345"        -> "Passive: <node name> (12345)"
 *   "Item:5:Belt"       -> "Item: Belt"  (slot index dropped)
 *   "Item"              -> "Item"
 *   "Config"            -> "Config"
 *   "Base"              -> "Base"
 *   "Skill:..."         -> "Skill: ..."
 * Falls back to the raw string for anything unrecognized.
 */
function humanizeSource(source: string): string {
  if (!source) return "?";
  if (source.startsWith("Tree:")) {
    const id = source.slice(5);
    const node = getPobNode(id);
    if (node && node.name) return `Passive: ${node.name} (${id})`;
    return `Passive node ${id}`;
  }
  if (source === "Base") return "Base (innate)";
  if (source === "Config") return "Config (PoB settings)";
  if (source.startsWith("Item")) {
    // "Item:5:Belt" or "Item:Belt" or just "Item"
    const parts = source.split(":");
    const label = parts[parts.length - 1];
    return label && label !== "Item" ? `Item: ${label}` : "Item";
  }
  if (source.startsWith("Skill:")) return `Skill: ${source.slice(6)}`;
  return source;
}

/** Sign-aware formatting of a contribution value for display. */
function formatValue(modType: string, value: number | boolean | string): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value;
  // numeric
  if (modType === "INC") return `${value > 0 ? "+" : ""}${value}%`;
  if (modType === "MORE") return `${value > 0 ? "+" : ""}${value}% more`;
  if (modType === "BASE") return `${value > 0 ? "+" : ""}${value}`;
  return String(value);
}

export interface StatBreakdownArgs {
  stat: string;
  actor?: "player" | "minion";
  raw_json?: boolean;
}

export async function handleGetStatBreakdown(
  context: StatBreakdownContext,
  args: StatBreakdownArgs
) {
  if (!args.stat || typeof args.stat !== "string") {
    return {
      content: [
        {
          type: "text",
          text:
            "Error: stat is required — a PoB modifier name like 'Life', " +
            "'FireResistance', 'Strength', 'Armour', 'EnergyShield', " +
            "'LifeRegen', 'Evasion', 'ChaosResistance'. (This is the mod " +
            "NAME, not always the same as a displayed stat label.)",
        },
      ],
      isError: true,
    };
  }

  try {
    await context.ensureLuaClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text",
          text: `Error connecting to PoB: ${msg}\nThis tool needs a live PoB build — launch via LaunchPoBWithAPI.bat, then retry.`,
        },
      ],
      isError: true,
    };
  }

  const client = context.getLuaClient();
  if (!client) {
    return {
      content: [{ type: "text", text: "Error: PoB Lua client not initialized." }],
      isError: true,
    };
  }

  let result: BreakdownResult;
  try {
    result = (await client.getStatBreakdown({ stat: args.stat, actor: args.actor })) as BreakdownResult;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error reading stat breakdown: ${msg}` }],
      isError: true,
    };
  }

  const contributions = result.contributions ?? [];

  if (args.raw_json) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ...result,
              contributions: contributions.map((c) => ({
                ...c,
                sourceHuman: humanizeSource(c.source),
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
  lines.push(`=== Breakdown: ${result.stat} (${result.actor}) ===`);
  if (result.output_value !== undefined && result.output_value !== null) {
    lines.push(`Current output value: ${result.output_value}`);
  }
  lines.push("");

  if (contributions.length === 0) {
    lines.push("No contributing modifiers found.");
    lines.push("");
    lines.push(
      "If you expected contributions, the stat name probably differs from " +
        "PoB's internal mod name. Common traps: resistances are the SHORT " +
        "form 'FireResist'/'ColdResist'/'LightningResist'/'ChaosResist' (NOT " +
        "'...Resistance'); attributes are 'Str'/'Dex'/'Int' (NOT " +
        "'Strength'/'Dexterity'/'Intelligence'). Verified-working names " +
        "include Life, Mana, EnergyShield, Armour, Evasion, LifeRegen, " +
        "ManaRegen, MovementSpeed, CritChance, CritMultiplier. Skill-" +
        "conditional stats (AttackSpeed, CastSpeed, damage) can't be " +
        "captured without active-skill config and may return empty."
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // Group by mod type for readability: BASE, INC, MORE, OVERRIDE, FLAG
  const order = ["BASE", "INC", "MORE", "OVERRIDE", "FLAG"];
  const byType = new Map<string, Contribution[]>();
  for (const c of contributions) {
    const arr = byType.get(c.modType) ?? [];
    arr.push(c);
    byType.set(c.modType, arr);
  }

  const typeLabel: Record<string, string> = {
    BASE: "Flat / base additions (added together)",
    INC: "Increased / reduced (additive %, summed then applied)",
    MORE: "More / less (multiplicative %)",
    OVERRIDE: "Overrides (replace the value)",
    FLAG: "Flags (on/off effects)",
  };

  for (const t of order) {
    const arr = byType.get(t);
    if (!arr || arr.length === 0) continue;
    // Sum numeric values for a quick subtotal where meaningful
    const numericSum = arr.reduce((acc, c) => acc + (typeof c.value === "number" ? c.value : 0), 0);
    const subtotal =
      t === "BASE" ? `  (sum: ${numericSum})` :
      t === "INC" ? `  (sum: ${numericSum > 0 ? "+" : ""}${numericSum}%)` :
      "";
    lines.push(`--- ${t} — ${typeLabel[t] ?? t}${subtotal} ---`);
    // Sort by descending absolute value so the biggest contributors lead
    arr.sort((a, b) => Math.abs(Number(b.value) || 0) - Math.abs(Number(a.value) || 0));
    for (const c of arr) {
      lines.push(`  ${formatValue(c.modType, c.value)}  ←  ${humanizeSource(c.source)}`);
    }
    lines.push("");
  }

  lines.push(
    "Note: source attribution uses PoB's live mod database. Accurate for " +
      "unconditional stats (life, resistances, attributes, armour/ES, regen). " +
      "Damage and other skill-conditional stats are INCOMPLETE here — the " +
      "breakdown uses no active-skill config, so conditional mods are omitted."
  );

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
