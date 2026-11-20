import { findGem, formatQualityTable, pctChange, type GemGroupLike } from '../../src/services/gemCompare.js';

const GROUPS: GemGroupLike[] = [
  { index: 1, slot: 'Gloves', includeInFullDPS: false, gems: [{ index: 1, name: "Assassin's Mark", level: 20, quality: 20 }] },
  {
    index: 5,
    slot: 'Body Armour',
    includeInFullDPS: true,
    gems: [
      { index: 1, name: 'More Duration', level: 20, quality: 20 },
      { index: 2, name: 'Multiple Totems', level: 20, quality: 0 },
      { index: 3, name: 'Invert the Rules', level: 3, quality: 20 },
      { index: 6, name: 'Storm Burst of Repulsion', level: 20, quality: 20 },
    ],
  },
  {
    index: 6,
    slot: 'Boots',
    includeInFullDPS: false,
    gems: [
      { index: 2, name: 'More Duration', level: 20, quality: 0 },
      { index: 3, name: 'Automation', level: 20, quality: 20 },
    ],
  },
];

describe('gemCompare - resolution', () => {
  it('finds a gem that appears once', () => {
    const r = findGem(GROUPS, { gem: 'Multiple Totems', mainSocketGroup: 5 });
    expect(r.ok).toBe(true);
    if (r.ok) expect([r.ref.groupIndex, r.ref.gemIndex, r.ref.quality]).toEqual([5, 2, 0]);
  });

  it('prefers the Full DPS group when the name repeats', () => {
    const r = findGem(GROUPS, { gem: 'More Duration', mainSocketGroup: 5 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ref.groupIndex).toBe(5);
  });

  it('refuses to guess between two equally valid groups', () => {
    const groups = GROUPS.map((g) => ({ ...g, includeInFullDPS: false }));
    const r = findGem(groups, { gem: 'More Duration' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.candidates).toHaveLength(2);
      expect(r.error).toContain('group_index or slot');
    }
  });

  it('honours slot and group filters', () => {
    const bySlot = findGem(GROUPS, { gem: 'More Duration', slot: 'boots' });
    expect(bySlot.ok).toBe(true);
    if (bySlot.ok) expect(bySlot.ref.groupIndex).toBe(6);

    const byGroup = findGem(GROUPS, { gem: 'More Duration', groupIndex: 5 });
    expect(byGroup.ok).toBe(true);
    if (byGroup.ok) expect(byGroup.ref.groupIndex).toBe(5);
  });

  it('reports a miss and lists the near matches', () => {
    const r = findGem(GROUPS, { gem: 'Duration', slot: 'Gloves' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.candidates.map((c) => c.name)).toContain('More Duration');
  });
});

describe('gemCompare - table', () => {
  it('measures against the lowest quality and marks the socketed value', () => {
    const text = formatQualityTable(
      [
        { quality: 0, fullDps: 26_785_542, totalDps: 4_500_000, pct: 0 },
        { quality: 20, fullDps: 31_655_685, totalDps: 5_275_145, pct: 18.2 },
      ],
      { gem: 'Storm Burst of Repulsion', level: 20, originalQuality: 20, slot: 'Body Armour' }
    );
    expect(text).toContain('| 20% (socketed) | 31.66M | +18.2% |');
    expect(text).toContain('Quality 0% → 20%: **+18.2% DPS**');
  });

  it('shows a zero delta honestly', () => {
    expect(pctChange(31_000_000, 31_000_000)).toBe(0);
    const text = formatQualityTable(
      [
        { quality: 0, fullDps: 31_000_000, totalDps: 5_000_000, pct: 0 },
        { quality: 20, fullDps: 31_000_000, totalDps: 5_000_000, pct: 0 },
      ],
      { gem: 'Multiple Totems', level: 20, originalQuality: 0 }
    );
    expect(text).toContain('Quality 0% → 20%: **0.0% DPS**');
  });
});
