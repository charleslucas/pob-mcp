/**
 * compute_stat_weights — empirical per-mod DPS/EHP sensitivity for the loaded build.
 *
 * Runs a battery of single-mod probes through the non-mutating GetMiscCalculator
 * closure (the probe_stat_weights Lua action): each probe clones the carrier
 * slot's item, appends one mod line, and reads the calc delta. The user's build
 * is never mutated — no undo state, no buildFlag, nothing changes in the GUI.
 *
 * Output is the build's *measured* scoring function: per-unit DPS/EHP weights
 * that replace hand-curated intuition in build-profile Sections 3-4 and feed
 * find_weighted_trade_items directly.
 */

import { wrapHandler } from "../utils/errorHandling.js";
import type { LuaHandlerContext } from "./luaHandlers.js";

interface Probe {
  mod: string;
  /** Magnitude of the probe, for per-unit normalization. */
  per: number;
  unit: string;
}

// Standard battery: common trade-searchable stat axes at realistic magnitudes.
// Magnitudes are large enough to rise above calc noise, small enough to stay
// in the locally-linear regime.
const DEFAULT_PROBES: Probe[] = [
  { mod: "+50 to maximum Life", per: 50, unit: "1 life" },
  { mod: "+50 to maximum Energy Shield", per: 50, unit: "1 ES" },
  { mod: "+50 to maximum Mana", per: 50, unit: "1 mana" },
  { mod: "8% increased maximum Life", per: 8, unit: "1% inc life" },
  { mod: "+20 to Strength", per: 20, unit: "1 str" },
  { mod: "+20 to Dexterity", per: 20, unit: "1 dex" },
  { mod: "+20 to Intelligence", per: 20, unit: "1 int" },
  { mod: "10% increased Attack Speed", per: 10, unit: "1% attack speed" },
  { mod: "10% increased Cast Speed", per: 10, unit: "1% cast speed" },
  { mod: "+25% to Global Critical Strike Multiplier", per: 25, unit: "1% crit multi" },
  { mod: "25% increased Global Critical Strike Chance", per: 25, unit: "1% inc crit chance" },
  { mod: "10% increased Elemental Damage with Attack Skills", per: 10, unit: "1% ele attack dmg" },
  { mod: "Adds 10 to 15 Physical Damage to Attacks", per: 1, unit: "10-15 flat phys" },
  { mod: "Adds 15 to 25 Fire Damage to Attacks", per: 1, unit: "15-25 flat fire" },
  { mod: "+13% to all Elemental Resistances", per: 13, unit: "1% all res" },
];

function fmt(n: number): string {
  if (Math.abs(n) >= 1000) return Math.round(n).toLocaleString();
  return String(Math.round(n * 100) / 100);
}

export async function handleComputeStatWeights(
  context: LuaHandlerContext,
  slot?: string,
  customMods?: string[]
) {
  return wrapHandler("compute stat weights", async () => {
    await context.ensureLuaClient();
    const luaClient = context.getLuaClient();
    if (!luaClient) throw new Error("Lua client not initialized. Use lua_start first.");
    if (typeof (luaClient as any).probeStatWeights !== "function") {
      throw new Error(
        "probe_stat_weights action unavailable — the PoB API Lua files predate this tool. " +
          "Re-run InstallTcpApi.ps1 (or relaunch via LaunchPoBWithAPI.bat) and restart PoB."
      );
    }

    const probes: Probe[] = customMods?.length
      ? customMods.map((m) => ({ mod: m, per: 1, unit: "probe" }))
      : DEFAULT_PROBES;

    const res = await (luaClient as any).probeStatWeights({
      slot,
      mods: probes.map((p) => p.mod),
    });

    const baseDPS = Number(res.base?.CombinedDPS) || 0;
    const baseEHP = Number(res.base?.TotalEHP) || 0;

    interface Row {
      probe: Probe;
      dpsDelta: number;
      ehpDelta: number;
      recognized: boolean;
      error?: string;
    }
    const rows: Row[] = res.results.map((r: any, i: number) => ({
      probe: probes[i] ?? { mod: String(r.mod), per: 1, unit: "probe" },
      dpsDelta: Number(r.dpsDelta) || 0,
      ehpDelta: Number(r.ehpDelta) || 0,
      recognized: r.recognized !== false && !r.error,
      error: r.error ? String(r.error) : undefined,
    }));

    const ok = rows.filter((r) => r.recognized && !r.error);
    const bad = rows.filter((r) => !r.recognized || r.error);
    ok.sort((a, b) => Math.abs(b.dpsDelta) / (baseDPS || 1) - Math.abs(a.dpsDelta) / (baseDPS || 1));

    const lines: string[] = [
      "=== Stat Weights (measured via live PoB sim; build not modified) ===",
      `Baseline: DPS ${fmt(baseDPS)} | EHP ${fmt(baseEHP)} — carrier: ${res.carrier} (${res.slot})`,
      "",
      "| Probe | DPS Δ | DPS Δ/unit | EHP Δ | EHP Δ/unit | DPS % |",
      "|---|---|---|---|---|---|",
    ];
    for (const r of ok) {
      const perUnitDps = r.dpsDelta / r.probe.per;
      const perUnitEhp = r.ehpDelta / r.probe.per;
      const pct = baseDPS > 0 ? (100 * r.dpsDelta) / baseDPS : 0;
      lines.push(
        `| ${r.probe.mod} | ${fmt(r.dpsDelta)} | ${fmt(perUnitDps)} per ${r.probe.unit} | ${fmt(r.ehpDelta)} | ${fmt(perUnitEhp)} | ${pct >= 0 ? "+" : ""}${fmt(pct)}% |`
      );
    }
    if (bad.length > 0) {
      lines.push("");
      lines.push(
        `⚠️ ${bad.length} probe(s) not usable (unrecognized mod text or calc error): ${bad.map((r) => `"${r.probe.mod}"${r.error ? ` (${r.error})` : ""}`).join("; ")}`
      );
    }
    lines.push("");
    lines.push(
      "Usage: these per-unit weights are this build's measured scoring function — feed them to " +
        "find_weighted_trade_items, and record the table (with today's date) in build-profile.md " +
        "Section 3/4 so future sessions rank mods by measurement, not intuition. Re-run after " +
        "respecs or major gear changes."
    );

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  });
}
