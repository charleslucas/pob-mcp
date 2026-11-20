import type { AnyLuaClient } from "../pobLuaBridge.js";
import { wrapHandler } from "../utils/errorHandling.js";
import {
  type CompareRow,
  describePaste,
  formatCompareTable,
  insertQuality,
  parsePrice,
  pct,
  stripNote,
} from "../services/itemCompare.js";

export interface ItemCompareContext {
  getLuaClient: () => AnyLuaClient | null;
  ensureLuaClient: () => Promise<void>;
}

export interface CompareCandidateArg {
  label?: string;
  text: string;
}

interface Metrics {
  fullDps: number;
  totalDps: number;
  ehp: number;
  life: number;
  es: number;
}

function metricsFrom(stats: Record<string, any>): Metrics {
  const num = (k: string) => {
    const v = Number(stats?.[k]);
    return Number.isFinite(v) ? v : 0;
  };
  return {
    fullDps: num('FullDPS'),
    totalDps: num('TotalDPS'),
    ehp: num('TotalEHP'),
    life: num('Life'),
    es: num('EnergyShield'),
  };
}

/**
 * Compare trade copy-pastes against the item currently in a slot.
 *
 * Every candidate is equipped in turn, PoB recalculates, and the numbers are
 * read off — no hand maths, no guessing which mods matter for this build. The
 * original item is put back afterwards (`restore`, default true) and the run
 * reports whether the final state matches the starting one.
 */
export async function handleCompareItems(
  context: ItemCompareContext,
  args: {
    slot: string;
    items: Array<string | CompareCandidateArg>;
    assume_quality?: number;
    chaos_per_div?: number;
    restore?: boolean;
  }
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  return wrapHandler('compare items', async () => {
    if (!args.slot || !args.slot.trim()) throw new Error('slot is required (e.g. "Weapon 1", "Body Armour")');
    const candidates: CompareCandidateArg[] = (args.items ?? []).map((it) =>
      typeof it === 'string' ? { text: it } : it
    );
    if (candidates.length === 0) throw new Error('items must contain at least one item copy-paste');

    await context.ensureLuaClient();
    const lua = context.getLuaClient();
    if (!lua) throw new Error('Lua bridge is not active — start PoB with the API (LaunchPoBWithAPI.bat).');

    const slot = args.slot.trim();
    const chaosPerDiv = args.chaos_per_div ?? 0;
    const restore = args.restore !== false;

    const equipped = (await lua.getItems()) as Array<{ slot?: string; raw?: string; name?: string; id?: number }>;
    const current = equipped.find((it) => String(it.slot ?? '').trim().toLowerCase() === slot.toLowerCase());
    const originalId = Number(current?.id) || 0;
    const originalRaw = originalId ? current?.raw : undefined;
    const addedIds: number[] = [];

    const baseStats = metricsFrom(await lua.getStats());
    const baseWarnings = await lua.getWarnings();

    const rows: CompareRow[] = [];
    if (originalRaw) {
      const header = describePaste(originalRaw);
      rows.push({
        label: `${header.name || 'equipped'}`,
        baseline: true,
        fullDps: baseStats.fullDps,
        totalDps: baseStats.totalDps,
        ehp: baseStats.ehp,
        life: baseStats.life,
        es: baseStats.es,
        warnings: baseWarnings.count,
        dpsPct: 0,
        ehpPct: 0,
      });
    }

    const failed: string[] = [];

    try {
      for (const candidate of candidates) {
        const clean = stripNote(candidate.text);
        const text = typeof args.assume_quality === 'number' ? insertQuality(clean, args.assume_quality) : clean;
        const header = describePaste(text);
        const price = parsePrice(candidate.text, chaosPerDiv);

        try {
          const added = await lua.addItem(text, slot);
          if (typeof added?.id === 'number') addedIds.push(added.id);
          const stats = metricsFrom(await lua.getStats());
          const w = await lua.getWarnings();
          rows.push({
            label: candidate.label || `${header.name || 'item'}${header.name && header.base ? ` (${header.base})` : ''}`,
            price: price.price,
            priceChaos: price.chaos,
            fullDps: stats.fullDps,
            totalDps: stats.totalDps,
            ehp: stats.ehp,
            life: stats.life,
            es: stats.es,
            warnings: w.count,
            addedWarnings: w.warnings.filter((x) => !baseWarnings.warnings.includes(x)),
            dpsPct: pct(baseStats.fullDps, stats.fullDps),
            ehpPct: pct(baseStats.ehp, stats.ehp),
          });
        } catch (err) {
          failed.push(`${candidate.label || header.name || 'item'}: ${(err as Error).message}`);
        }
      }
    } finally {
      if (restore) {
        try {
          // Re-select the original by id and delete the candidates: no duplicate
          // copy of the original, no leftover test items. Also empties a slot that
          // started empty.
          await lua.restoreItemSlot(slot, originalId, addedIds);
          addedIds.length = 0;
        } catch {
          // PoB API without restore_item_slot (not relaunched since the update):
          // fall back to re-adding the original's text.
          try {
            if (originalRaw) await lua.addItem(originalRaw, slot);
            else await lua.clearItemSlot(slot);
          } catch {
            /* reported through the restore check below */
          }
        }
      }
    }

    let restoreNote = '';
    if (restore) {
      const after = metricsFrom(await lua.getStats());
      const back = Math.abs(after.fullDps - baseStats.fullDps) < 1 && Math.abs(after.ehp - baseStats.ehp) < 1;
      restoreNote = back
        ? `${slot}: ${originalId ? 'original item restored' : 'slot emptied again'} (${after.fullDps.toFixed(0)} DPS, ${after.ehp.toFixed(0)} EHP — matches the start).`
        : `⚠️ ${slot}: restore did NOT return to the starting numbers (now ${after.fullDps.toFixed(0)} DPS) — reload the build before saving.`;
    }

    const parts = [formatCompareTable(rows, { slot, chaosPerDiv })];
    if (args.assume_quality) parts.push(`Quality assumed at ${args.assume_quality}% for pastes that do not state one.`);
    if (restoreNote) parts.push(restoreNote);
    if (failed.length) parts.push(`Skipped: ${failed.join('; ')}`);
    if (addedIds.length > 0) {
      parts.push(
        restore
          ? 'The tested items could not be removed (PoB API predates restore_item_slot — relaunch PoB via LaunchPoBWithAPI.bat); they remain in the item list. Do not save the build unless you meant to keep them.'
          : `restore:false — the last candidate is still equipped and all ${addedIds.length} tested item(s) remain in the item list.`
      );
    }

    return { content: [{ type: 'text' as const, text: parts.join('\n\n') }] };
  });
}
