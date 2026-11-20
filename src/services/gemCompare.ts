/**
 * Gem quality comparison: "does quality on THIS gem add damage, and how much".
 *
 * Quality is not a uniform stat. On one gem it is a large multiplier, on another
 * it is literally 0.0% (measured: a support whose quality only touches a
 * defensive or utility stat), and a gem bought at 20/20 costs several times a
 * 20/0 copy. So the only honest answer is a measurement: set the quality, read
 * PoB, put it back.
 *
 * Everything here is pure so the resolution rules and the table can be tested
 * without the Lua bridge.
 */

export interface GemRef {
  groupIndex: number;
  gemIndex: number;
  name: string;
  level: number;
  quality: number;
  slot?: string;
  /** Group feeds Full DPS (or is the main socket group). */
  main: boolean;
}

export interface GemGroupLike {
  index: number;
  slot?: string;
  includeInFullDPS?: boolean;
  gems?: Array<{ index: number; name: string; level?: number; quality?: number; enabled?: boolean }>;
}

export interface FindGemOptions {
  /** Case-insensitive substring of the gem name, e.g. "More Duration". */
  gem: string;
  /** 1-based socket group index, when the caller already knows it. */
  groupIndex?: number;
  /** Slot filter, e.g. "Body Armour" — alternative to groupIndex. */
  slot?: string;
  /** The build's main socket group; used to break ties. */
  mainSocketGroup?: number;
}

export type FindGemResult =
  | { ok: true; ref: GemRef }
  | { ok: false; error: string; candidates: GemRef[] };

function toRefs(groups: GemGroupLike[], mainSocketGroup?: number): GemRef[] {
  const refs: GemRef[] = [];
  for (const g of groups) {
    for (const gem of g.gems ?? []) {
      refs.push({
        groupIndex: g.index,
        gemIndex: gem.index,
        name: gem.name,
        level: gem.level ?? 1,
        quality: gem.quality ?? 0,
        slot: g.slot,
        main: g.includeInFullDPS === true || g.index === mainSocketGroup,
      });
    }
  }
  return refs;
}

function describe(ref: GemRef): string {
  return `group ${ref.groupIndex}${ref.slot ? ` (${ref.slot})` : ''}, gem ${ref.gemIndex}: ${ref.name} ${ref.level}/${ref.quality}`;
}

/**
 * Resolve a gem by name. Ambiguity is an error, not a guess: the same support
 * can sit in three different links and their quality is worth different amounts.
 */
export function findGem(groups: GemGroupLike[], opts: FindGemOptions): FindGemResult {
  const needle = String(opts.gem ?? '').trim().toLowerCase();
  if (!needle) return { ok: false, error: 'gem name is required', candidates: [] };

  let refs = toRefs(groups, opts.mainSocketGroup).filter((r) => r.name.toLowerCase().includes(needle));
  if (opts.groupIndex !== undefined) refs = refs.filter((r) => r.groupIndex === opts.groupIndex);
  if (opts.slot) {
    const slot = opts.slot.trim().toLowerCase();
    refs = refs.filter((r) => String(r.slot ?? '').trim().toLowerCase() === slot);
  }

  if (refs.length === 0) {
    return {
      ok: false,
      error: `no gem matching "${opts.gem}"${opts.slot ? ` in ${opts.slot}` : ''}${opts.groupIndex ? ` in group ${opts.groupIndex}` : ''}`,
      candidates: toRefs(groups, opts.mainSocketGroup).filter((r) => r.name.toLowerCase().includes(needle)),
    };
  }
  if (refs.length > 1) {
    const main = refs.filter((r) => r.main);
    if (main.length === 1) return { ok: true, ref: main[0] };
    return {
      ok: false,
      error: `"${opts.gem}" is socketed in ${refs.length} groups — pass group_index or slot to pick one`,
      candidates: refs,
    };
  }
  return { ok: true, ref: refs[0] };
}

export interface QualityRow {
  quality: number;
  fullDps: number;
  totalDps: number;
  /** Percent change of Full DPS against the lowest measured quality. */
  pct: number;
}

export function pctChange(from: number, to: number): number {
  if (!from || !Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return ((to - from) / from) * 100;
}

function fmtDps(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '—';
  return v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}k` : v.toFixed(0);
}

function fmtPct(v: number): string {
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}%`;
}

/**
 * Markdown table of quality -> DPS. The lowest quality is the reference, so the
 * numbers answer "what does the extra quality buy me", not "what is the gem
 * worth" (a gem's worth is its level + link, measured elsewhere).
 */
export function formatQualityTable(
  rows: QualityRow[],
  info: { gem: string; level: number; originalQuality: number; slot?: string; note?: string }
): string {
  if (rows.length === 0) return 'No quality values measured.';
  const sorted = [...rows].sort((a, b) => a.quality - b.quality);
  const lines = [
    `=== Gem quality — ${info.gem} ${info.level}/${info.originalQuality}${info.slot ? ` in ${info.slot}` : ''} ===`,
    '',
    '| quality | FullDPS | vs lowest |',
    '|---|---|---|',
  ];
  for (const r of sorted) {
    const mark = r.quality === info.originalQuality ? ' (socketed)' : '';
    const delta = r.quality === sorted[0].quality ? '—' : fmtPct(r.pct);
    lines.push(`| ${r.quality}%${mark} | ${fmtDps(r.fullDps)} | ${delta} |`);
  }
  const lo = sorted[0];
  const hi = sorted[sorted.length - 1];
  lines.push('');
  if (hi.quality !== lo.quality) {
    lines.push(`Quality ${lo.quality}% → ${hi.quality}%: **${fmtPct(pctChange(lo.fullDps, hi.fullDps))} DPS**.`);
  }
  if (info.note) lines.push(info.note);
  return lines.join('\n');
}
