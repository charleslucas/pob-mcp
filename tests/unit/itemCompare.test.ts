import {
  describePaste,
  formatCompareTable,
  formatDps,
  insertQuality,
  parsePrice,
  pct,
  stripNote,
  type CompareRow,
} from '../../src/services/itemCompare.js';

const PASTE = `Item Class: Wands
Rarity: Unique
Grace of the Goddess
Prophecy Wand
--------
Wand
Physical Damage: 111-205 (augmented)
Critical Strike Chance: 8.70%
Attacks per Second: 1.50
--------
Requirements:
Level: 68
Int: 245
--------
Sockets: W-W
--------
Item Level: 87
--------
40% increased Spell Damage
--------
327% increased Physical Damage
Gain 37% of Physical Damage as Extra Fire Damage
Gain 19% of Physical Damage as Extra Cold Damage
Gain 47% of Physical Damage as Extra Lightning Damage
--------
In a time of darkness, know that the Draíocht will bring you light.
--------
Note: ~b/o 1 divine`;

function row(over: Partial<CompareRow> = {}): CompareRow {
  return {
    label: 'item',
    fullDps: 30_000_000,
    totalDps: 5_000_000,
    ehp: 80_000,
    life: 3600,
    es: 1000,
    warnings: 0,
    dpsPct: 0,
    ehpPct: 0,
    ...over,
  };
}

describe('itemCompare - trade paste', () => {
  it('reads rarity, name and base from the header', () => {
    expect(describePaste(PASTE)).toEqual({
      rarity: 'Unique',
      name: 'Grace of the Goddess',
      base: 'Prophecy Wand',
    });
  });

  it('parses a b/o note in divines into chaos', () => {
    expect(parsePrice(PASTE, 225)).toEqual({ price: '1 divine', chaos: 225 });
  });

  it('parses chaos prices and ignores a missing note', () => {
    expect(parsePrice('Note: ~price 100 chaos')).toEqual({ price: '100 chaos', chaos: 100 });
    expect(parsePrice('Rarity: Unique')).toEqual({});
  });

  it('leaves a price it cannot convert without inventing a chaos value', () => {
    expect(parsePrice('Note: ~b/o 2 exalted', 225)).toEqual({ price: '2 exalted' });
  });

  it('strips the note line so it never reaches PoB as a mod', () => {
    const cleaned = stripNote(PASTE);
    expect(cleaned).not.toMatch(/Note:/);
    expect(cleaned).toMatch(/Prophecy Wand/);
  });

  it('inserts quality only when the paste has none', () => {
    const withQuality = insertQuality(PASTE, 20);
    expect(withQuality).toMatch(/Item Level: 87\nQuality: 20\n/);
    expect(insertQuality(withQuality, 20)).toBe(withQuality);
  });

  it('clamps an absurd quality instead of writing it through', () => {
    expect(insertQuality(PASTE, 99)).toMatch(/Quality: 30/);
    expect(insertQuality(PASTE, -5)).toMatch(/Quality: 0/);
  });
});

describe('itemCompare - table', () => {
  it('sorts by DPS, keeps the baseline visible and marks it', () => {
    const text = formatCompareTable(
      [
        row({ label: 'base wand', baseline: true }),
        row({ label: 'cheap', fullDps: 28_000_000, dpsPct: -6.7 }),
        row({ label: 'dear', fullDps: 31_000_000, dpsPct: 3.3, price: '2 divine', priceChaos: 450 }),
      ],
      { slot: 'Weapon 1', chaosPerDiv: 225 }
    );
    const lines = text.split('\n');
    expect(lines[4]).toContain('dear');
    expect(lines[5]).toContain('base wand');
    expect(lines[6]).toContain('cheap');
    expect(text).toContain('base wand (equipped)');
    expect(text).toContain('Best DPS: **dear**');
  });

  it('flags a candidate that raises the warning count', () => {
    const text = formatCompareTable(
      [
        row({ label: 'equipped', baseline: true }),
        row({ label: 'risky', warnings: 2, dpsPct: 1.1, addedWarnings: ['You have too many gems in your Weapon 1 slot'] }),
      ],
      { slot: 'Gloves' }
    );
    expect(text).toContain('risky: You have too many gems');
  });

  it('lists the candidate names when only the count is known', () => {
    const text = formatCompareTable(
      [row({ label: 'equipped', baseline: true }), row({ label: 'risky', warnings: 2, dpsPct: 1.1 })],
      { slot: 'Gloves' }
    );
    expect(text).toContain('raise on: risky');
  });

  it('formats magnitudes and percentages readably', () => {
    expect(formatDps(31_655_685)).toBe('31.66M');
    expect(formatDps(0)).toBe('—');
    expect(pct(100, 94)).toBeCloseTo(-6);
  });
});
