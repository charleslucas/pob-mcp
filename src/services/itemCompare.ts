/**
 * Item comparison helpers.
 *
 * The question a buyer actually has is "is this listing better than what I have,
 * and by how much", and the answer is already computable: PoB prices every
 * equipped item in DPS and EHP. So the flow is paste -> parse -> equip -> read ->
 * restore -> table. Everything in this file is pure (no Lua, no I/O) so the
 * parsing and the table can be unit-tested on their own; the handler does the
 * measuring.
 *
 * A trade copy-paste is *not* PoB item text: it carries `Item Class:` and
 * `Note: ~b/o …` lines and it usually omits quality. PoB's parser accepts the
 * in-game format natively, so the text is passed through almost untouched —
 * only the price is stripped and quality is inserted when the caller assumes it.
 */

export interface ParsedPrice {
  /** Human-readable form of the price from the note, e.g. `2 divine`. */
  price?: string;
  /** Same price in chaos, when the currency is convertible (divine/chaos). */
  chaos?: number;
}

export interface PasteHeader {
  rarity: string;
  name: string;
  base: string;
}

export interface CompareRow {
  label: string;
  price?: string;
  priceChaos?: number;
  fullDps: number;
  totalDps: number;
  ehp: number;
  life: number;
  es: number;
  warnings: number;
  /** Warning lines this candidate adds over the equipped item (PoB's own text). */
  addedWarnings?: string[];
  dpsPct: number;
  ehpPct: number;
  baseline?: boolean;
}

const CURRENCY_TO_CHAOS: Record<string, string> = {
  chaos: 'chaos',
  c: 'chaos',
  divine: 'divine',
  div: 'divine',
};

/**
 * `Note: ~b/o 2 divine` / `Note: ~price 100 chaos` -> `{ price, chaos }`.
 * Divine is converted with the caller's rate; anything else is reported raw.
 */
export function parsePrice(raw: string, chaosPerDiv = 0): ParsedPrice {
  const m = String(raw).match(/^\s*Note:\s*(?:~)?(?:b\/o|price)?\s*([\d.]+)\s*([a-z]+)\s*$/im);
  if (!m) return {};
  const amount = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (!Number.isFinite(amount)) return {};
  const kind = CURRENCY_TO_CHAOS[unit];
  const price = `${m[1]} ${m[2]}`;
  if (kind === 'chaos') return { price, chaos: amount };
  if (kind === 'divine' && chaosPerDiv > 0) return { price, chaos: amount * chaosPerDiv };
  return { price };
}

/** Header block: `Item Class:` is ignored, `Rarity:` then name then base. */
export function describePaste(raw: string): PasteHeader {
  const lines = String(raw)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const ri = lines.findIndex((l) => /^Rarity:/i.test(l));
  if (ri < 0) return { rarity: '', name: '', base: '' };
  return {
    rarity: lines[ri].split(':')[1]?.trim() ?? '',
    name: lines[ri + 1] ?? '',
    base: lines[ri + 2] ?? '',
  };
}

/**
 * Add `Quality: N` when the paste does not state one — trade listings omit it,
 * and comparing a 0% copy against a 20% equipped item is not a comparison.
 */
export function insertQuality(raw: string, quality: number): string {
  const text = String(raw);
  if (/^\s*Quality:/im.test(text)) return text;
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => /^Item Level:/i.test(l));
  // Insert after `Item Level:` — the position PoB itself writes it in. Fall back
  // to just before the implicits when the paste has no item level line.
  const idx = at >= 0 ? at + 1 : lines.findIndex((l) => /^Implicits:/i.test(l));
  lines.splice(idx >= 0 ? idx : lines.length, 0, `Quality: ${Math.max(0, Math.min(30, Math.round(quality)))}`);
  return lines.join('\n');
}

/** Strip the price note so it never reaches PoB's parser as a mod line. */
export function stripNote(raw: string): string {
  return String(raw)
    .split(/\r?\n/)
    .filter((l) => !/^\s*Note:/i.test(l))
    .join('\n');
}

export function formatDps(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—';
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(0)}k`;
  return value.toFixed(0);
}

export function formatPct(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

export function pct(base: number, value: number): number {
  if (!base || !Number.isFinite(base) || !Number.isFinite(value)) return 0;
  return ((value - base) / base) * 100;
}

/**
 * Markdown table, best DPS first. The baseline row stays visible so the reader
 * sees what "better" is measured against, and a row that adds PoB warnings is
 * called out — a DPS gain that breaks an attribute requirement is a loss.
 */
export function formatCompareTable(rows: CompareRow[], opts: { slot: string; chaosPerDiv?: number } = { slot: '' }): string {
  if (rows.length === 0) return 'No candidates to compare.';
  const sorted = [...rows].sort((a, b) => b.fullDps - a.fullDps || b.ehp - a.ehp);
  const lines = [
    `=== Item comparison — ${opts.slot || 'slot'} ===`,
    '',
    '| # | item | price | FullDPS | vs base | EHP | vs base | warnings |',
    '|---|---|---|---|---|---|---|---|',
  ];
  sorted.forEach((r, i) => {
    const name = r.baseline ? `${r.label} (equipped)` : r.label;
    const warn = r.warnings > 0 ? `**${r.warnings}**` : '—';
    lines.push(
      `| ${i + 1} | ${name} | ${r.price ?? '—'} | ${formatDps(r.fullDps)} | ${r.baseline ? '—' : formatPct(r.dpsPct)} | ${formatDps(r.ehp)} | ${r.baseline ? '—' : formatPct(r.ehpPct)} | ${warn} |`
    );
  });
  const best = sorted.find((r) => !r.baseline);
  if (best && rows.some((r) => r.baseline)) {
    const base = rows.find((r) => r.baseline)!;
    lines.push('');
    lines.push(
      `Best DPS: **${best.label}** at ${formatDps(best.fullDps)} (${formatPct(best.dpsPct)} vs equipped), EHP ${formatPct(best.ehpPct)}.`
    );
    if (best.priceChaos && best.dpsPct > 0 && opts.chaosPerDiv) {
      const divCost = (best.priceChaos - (base.priceChaos ?? 0)) / opts.chaosPerDiv;
      if (divCost > 0) lines.push(`Costs ${divCost.toFixed(2)} div more than the equipped item for ${formatPct(best.dpsPct)} DPS.`);
    }
  }
  const warned = sorted.filter((r) => r.warnings > (rows.find((x) => x.baseline)?.warnings ?? 0));
  if (warned.length) {
    lines.push('');
    lines.push('Warnings added (PoB\'s own text — a DPS gain that breaks a requirement is a loss):');
    for (const w of warned) {
      for (const text of w.addedWarnings ?? []) lines.push(`- ${w.label}: ${text}`);
    }
    if (!warned.some((w) => (w.addedWarnings ?? []).length > 0)) {
      lines.push(`- raise on: ${warned.map((r) => r.label).join(', ')}`);
    }
  }
  return lines.join('\n');
}
