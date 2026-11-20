import type { AnyLuaClient } from "../pobLuaBridge.js";
import { wrapHandler } from "../utils/errorHandling.js";
import { findGem, formatQualityTable, pctChange, type GemGroupLike, type QualityRow } from "../services/gemCompare.js";

export interface GemCompareContext {
  getLuaClient: () => AnyLuaClient | null;
  ensureLuaClient: () => Promise<void>;
}

interface Metrics {
  fullDps: number;
  totalDps: number;
}

function metricsFrom(stats: Record<string, any>): Metrics {
  const num = (k: string) => {
    const v = Number(stats?.[k]);
    return Number.isFinite(v) ? v : 0;
  };
  return { fullDps: num('FullDPS'), totalDps: num('TotalDPS') };
}

/**
 * Measure what a gem's quality is worth: set each quality, read PoB, restore.
 *
 * Answers "buy 20/0 or 20/20" with a number instead of a guess; quality on some
 * supports is worth exactly 0.0%, which is invisible from the mod text.
 */
export async function handleCompareGemQuality(
  context: GemCompareContext,
  args: {
    gem: string;
    group_index?: number;
    slot?: string;
    qualities?: number[];
  }
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  return wrapHandler('compare gem quality', async () => {
    if (!args.gem || !String(args.gem).trim()) throw new Error('gem is required (a name or part of it)');

    await context.ensureLuaClient();
    const lua = context.getLuaClient();
    if (!lua) throw new Error('Lua bridge is not active — start PoB with the API (LaunchPoBWithAPI.bat).');

    const skills = (await lua.getSkills()) as { mainSocketGroup?: number; groups?: GemGroupLike[] };
    const found = findGem(skills.groups ?? [], {
      gem: args.gem,
      groupIndex: args.group_index,
      slot: args.slot,
      mainSocketGroup: skills.mainSocketGroup,
    });

    if (!found.ok) {
      const list = found.candidates.map((c) => `- group ${c.groupIndex}${c.slot ? ` (${c.slot})` : ''}: ${c.name} ${c.level}/${c.quality}`).join('\n');
      throw new Error(`${found.error}${list ? `\n${list}` : ''}`);
    }

    const ref = found.ref;
    const qualities = (args.qualities && args.qualities.length > 0 ? args.qualities : [0, 20])
      .map((q) => Math.max(0, Math.round(q)))
      .filter((q, i, all) => all.indexOf(q) === i)
      .sort((a, b) => a - b);

    const base = metricsFrom(await lua.getStats());
    const rows: QualityRow[] = [];
    const failed: string[] = [];

    try {
      for (const quality of qualities) {
        try {
          await lua.setGemQuality({ groupIndex: ref.groupIndex, gemIndex: ref.gemIndex, quality });
          const m = metricsFrom(await lua.getStats());
          rows.push({ quality, fullDps: m.fullDps, totalDps: m.totalDps, pct: 0 });
        } catch (err) {
          failed.push(`${quality}%: ${(err as Error).message}`);
        }
      }
    } finally {
      try {
        await lua.setGemQuality({ groupIndex: ref.groupIndex, gemIndex: ref.gemIndex, quality: ref.quality });
      } catch {
        /* reported below */
      }
    }

    const reference = rows.filter((r) => r.quality === qualities[0])[0] ?? rows[0];
    for (const r of rows) r.pct = pctChange(reference?.fullDps ?? 0, r.fullDps);

    const after = metricsFrom(await lua.getStats());
    const restored = Math.abs(after.fullDps - base.fullDps) < 1;

    const parts = [
      formatQualityTable(rows, {
        gem: ref.name,
        level: ref.level,
        originalQuality: ref.quality,
        slot: ref.slot,
        note: 'Quality added by items (e.g. an amulet that grants quality to all gems) is left in place — these numbers are the marginal value of this gem\'s own quality.',
      }),
      restored
        ? `Gem restored to ${ref.level}/${ref.quality} (${after.fullDps.toFixed(0)} DPS — matches the start).`
        : `⚠️ Did not return to the starting DPS (now ${after.fullDps.toFixed(0)}) — check the gem's quality before saving.`,
    ];
    if (failed.length) parts.push(`Skipped: ${failed.join('; ')}`);

    return { content: [{ type: 'text' as const, text: parts.join('\n\n') }] };
  });
}
