/**
 * minion_dps_breakdown — per-skill Full DPS table for minion/multi-skill builds.
 *
 * Reads PoB's already-cached MAIN output (mainOutput.SkillDPS) — the same
 * numbers the GUI's Full DPS tooltip shows. Free: no recompute, no mutation.
 *
 * Two facts every consumer must know:
 * - `dps` per skill is PER INSTANCE (one minion); `count` is the socket
 *   group's manually-set "Count" field. PoB does NOT auto-multiply by the
 *   build's minion limit — an unset Count silently under-reports the swarm.
 * - Only socket groups with "Include in Full DPS" checked appear at all.
 */

import { wrapHandler } from "../utils/errorHandling.js";
import type { LuaHandlerContext } from "./luaHandlers.js";

function fmt(n: number): string {
  return Math.abs(n) >= 1000 ? Math.round(n).toLocaleString() : String(Math.round(n * 100) / 100);
}

interface BreakdownRow {
  name: string;
  total: number;
  skillPart?: string;
}

/** Community rules of thumb from playbooks/dps-analysis.md. They are not measurements. */
const UPTIME_SCENARIOS = [
  { label: "Stationary target, ranged or triggered minions", low: 0.9, high: 0.95 },
  { label: "Moving target, melee minions", low: 0.6, high: 0.8 },
];

/** PoB labels a minion's row "Minion Name: Skill Part". */
const isMinionRow = (r: BreakdownRow) => (r.skillPart ?? "").includes(": ");
/** Ailment and DoT roll-ups, which PoB does not attribute per skill. */
const isRollupRow = (r: BreakdownRow) => /^(Best|Full) .+ DPS$|^Corrupting Blood DPS$/.test(r.name);

function realisticEstimateLines(rows: BreakdownRow[], fullDps: number): string[] {
  const sum = (list: BreakdownRow[]) => list.reduce((acc, r) => acc + r.total, 0);
  const minionHits = sum(rows.filter(isMinionRow));
  if (minionHits <= 0 || fullDps <= 0) return [];
  const otherHits = sum(rows.filter((r) => !isMinionRow(r) && !isRollupRow(r)));
  const rollups = sum(rows.filter(isRollupRow));
  const minionPart = Math.min(fullDps, minionHits + rollups * (minionHits / (minionHits + otherHits)));
  const otherPart = fullDps - minionPart;

  return [
    "",
    "**Realistic estimate (rule of thumb, not measured):**",
    `Minion-driven damage: ${fmt(minionPart)} of ${fmt(fullDps)} Full DPS (${fmt((100 * minionPart) / fullDps)}%). ` +
      "Ailment and DoT rows are split by each side's share of direct hits.",
    "",
    "| Scenario | Minion uptime | Estimated Full DPS |",
    "|---|---|---|",
    ...UPTIME_SCENARIOS.map(
      (s) =>
        `| ${s.label} | ${Math.round(s.low * 100)}-${Math.round(s.high * 100)}% | ` +
        `${fmt(otherPart + minionPart * s.low)} - ${fmt(otherPart + minionPart * s.high)} |`
    ),
    "",
    "Pick the row that fits the fight. These ranges cover minions losing attack time only: the Count " +
      "values and any buffs PoB treats as permanent are still taken at face value. Calibrate against a timed kill.",
  ];
}

export async function handleMinionDpsBreakdown(context: LuaHandlerContext) {
  return wrapHandler("get minion DPS breakdown", async () => {
    await context.ensureLuaClient();
    const luaClient = context.getLuaClient();
    if (!luaClient) throw new Error("Lua client not initialized. Use lua_start first.");
    if (typeof (luaClient as any).getFullDpsBreakdown !== "function") {
      throw new Error(
        "get_full_dps_breakdown action unavailable — the PoB API Lua files predate this tool. " +
          "Relaunch PoB via LaunchPoBWithAPI.bat and restart PoB."
      );
    }

    const res = await (luaClient as any).getFullDpsBreakdown();

    if (!res.skills.length) {
      return {
        content: [
          {
            type: "text" as const,
            text: [
              "=== Full DPS Breakdown ===",
              "",
              "No socket groups are flagged for Full DPS — the per-skill breakdown is empty.",
              "",
              "To get build-level DPS for a minion (or multi-skill) build:",
              '1. In PoB\'s Skills tab, check "Include in Full DPS" on every damage-contributing socket group (each minion type, triggered skills, etc.).',
              '2. Set each group\'s "Count" field to the number of active instances (e.g. 10 zombies, 4 relics). PoB does NOT auto-multiply by your minion limit — an unset Count means the group counts once.',
              "3. Re-run this tool. The main-skill DPS shown elsewhere is a single skill, not the swarm.",
              `Current player/main-skill DPS: ${fmt(res.playerDPS)}.`,
            ].join("\n"),
          },
        ],
      };
    }

    const rows = res.skills
      .map((s: { name: string; dps: number; count: number; trigger?: string; skillPart?: string; source?: string }) => ({
        ...s,
        total: s.dps * s.count,
      }))
      .sort((a: { total: number }, b: { total: number }) => b.total - a.total);
    const grandTotal = res.fullDPS || rows.reduce((acc: number, r: { total: number }) => acc + r.total, 0);

    const lines: string[] = [
      "=== Full DPS Breakdown (per-skill, from PoB's cached calc) ===",
      `Full DPS total: ${fmt(res.fullDPS)}${res.fullDotDPS ? ` (DoT portion: ${fmt(res.fullDotDPS)})` : ""} | main-skill/player DPS alone: ${fmt(res.playerDPS)}`,
      "",
      "| Skill | Count | DPS per instance | Total | Share |",
      "|---|---|---|---|---|",
    ];
    for (const r of rows) {
      const share = grandTotal > 0 ? (100 * r.total) / grandTotal : 0;
      const label = r.skillPart ? `${r.name} (${r.skillPart})` : r.name;
      lines.push(`| ${label}${r.source ? ` ← ${r.source}` : ""} | ${r.count} | ${fmt(r.dps)} | ${fmt(r.total)} | ${fmt(share)}% |`);
    }
    lines.push("");
    lines.push(
      "⚠️ `Count` comes from each socket group's manually-set Count field — verify it matches the real " +
        "minion quantity (PoB does not auto-fill it from your minion limit). Any group missing " +
        '"Include in Full DPS" is absent from this table entirely.'
    );
    lines.push(
      "PoB assumes perfect minion uptime, so the totals above are a best case " +
        "(playbooks/dps-analysis.md, minion section)."
    );
    lines.push(...realisticEstimateLines(rows, grandTotal));

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  });
}
