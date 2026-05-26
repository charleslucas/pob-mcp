import { describe, it, expect } from '@jest/globals';
import { existsSync } from 'fs';
import { resolve } from 'path';

import {
  ensureLoaded,
  getMod,
  getModCount,
  getModGroup,
  resolveWeightForTag,
  resolveWeightForTags,
  searchMods,
} from '../../src/services/pobModDataLoader';

const pobDir = process.env.POB_DIRECTORY ?? resolve(process.cwd(), '..', 'PathOfBuilding');
const hasModData = existsSync(resolve(pobDir, 'src', 'Data', 'ModItem.lua'));

const describeIfPob = hasModData ? describe : describe.skip;

describeIfPob('pobModDataLoader', () => {
  it('parses ModItem.lua and exposes thousands of mod entries', () => {
    ensureLoaded();
    expect(getModCount()).toBeGreaterThan(5000);
  });

  it('returns null for an unknown mod ID', () => {
    expect(getMod('NotARealModId__')).toBeNull();
  });

  it('returns Strength1 with expected shape', () => {
    const m = getMod('Strength1');
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.type).toBe('Suffix');
    expect(m.affix).toBe('of the Brute');
    expect(m.level).toBe(1);
    expect(m.group).toBe('Strength');
    expect(m.statLines.length).toBeGreaterThan(0);
    expect(m.statLines[0]).toMatch(/Strength/);
    expect(m.modTags).toContain('attribute');
    expect(m.weights.length).toBeGreaterThan(0);
  });

  it('returns a multi-stat mod with all stat lines preserved', () => {
    // IncreasedLifeEnhancedMod has two stat lines (life flat + life percent)
    const m = getMod('IncreasedLifeEnhancedMod');
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.statLines.length).toBe(2);
    expect(m.statLines[0]).toMatch(/maximum Life/);
    expect(m.statLines[1]).toMatch(/increased maximum Life/);
  });

  it('groups mods by their group field', () => {
    const lifeGroup = getModGroup('IncreasedLife');
    expect(lifeGroup.length).toBeGreaterThan(10);
    expect(lifeGroup.every((m) => m.group === 'IncreasedLife')).toBe(true);
  });

  it('resolveWeightForTag returns the explicit tag weight when present', () => {
    const m = getMod('Strength1');
    expect(m).not.toBeNull();
    if (!m) return;
    expect(resolveWeightForTag(m, 'ring')).toBe(1000);
  });

  it('resolveWeightForTag falls through to default when tag is absent', () => {
    // IncreasedLife6 has weightKey { fishing_rod, weapon, default } with weights { 0, 0, 1000 }.
    // Querying for "body_armour" should fall through to default (1000).
    const m = getMod('IncreasedLife6');
    expect(m).not.toBeNull();
    if (!m) return;
    expect(resolveWeightForTag(m, 'body_armour')).toBe(1000);
  });

  it('resolveWeightForTags walks the weights and matches any input tag', () => {
    // FireResist mods list "armour" (parent tag) — a body_armour base should
    // match via the "armour" entry when both are supplied.
    const m = getMod('FireResist6');
    expect(m).not.toBeNull();
    if (!m) return;
    expect(resolveWeightForTags(m, ['body_armour'])).toBe(0); // would miss; default=0
    expect(resolveWeightForTags(m, ['body_armour', 'armour'])).toBe(1000);
  });

  describe('searchMods', () => {
    it('filters by stat substring (case-insensitive)', () => {
      const hits = searchMods({ statContains: 'fire resistance', limit: 20 });
      expect(hits.length).toBeGreaterThan(0);
      expect(
        hits.every((m) => m.statLines.some((s) => /fire resistance/i.test(s)))
      ).toBe(true);
    });

    it('filters by type Prefix/Suffix', () => {
      const prefixes = searchMods({ statContains: 'maximum Life', type: 'Prefix', limit: 50 });
      expect(prefixes.length).toBeGreaterThan(0);
      expect(prefixes.every((m) => m.type === 'Prefix')).toBe(true);
    });

    it('filters by min/max level', () => {
      const hits = searchMods({
        statContains: 'maximum Life',
        minLevel: 70,
        maxLevel: 80,
        type: 'Prefix',
        limit: 50,
      });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((m) => m.level >= 70 && m.level <= 80)).toBe(true);
    });

    it('filters by item-tag chain (Astral Plate)', () => {
      // Astral Plate carries ["body_armour","armour","str_armour"] in PoE's
      // base-item data. Fire Resistance mods list "armour" not "body_armour"
      // — single-tag filtering misses; multi-tag should not.
      const tags = ['body_armour', 'armour', 'str_armour'];
      const hits = searchMods({
        statContains: 'Fire Resistance',
        itemTags: tags,
        type: 'Suffix',
        limit: 20,
      });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((m) => resolveWeightForTags(m, tags) > 0)).toBe(true);
    });

    it('filters by mod group', () => {
      const hits = searchMods({ group: 'IncreasedLife', limit: 200 });
      expect(hits.length).toBeGreaterThan(10);
      expect(hits.every((m) => m.group === 'IncreasedLife')).toBe(true);
    });

    it('filters by hasTags (all tags must be present)', () => {
      const hits = searchMods({ hasTags: ['attribute'], limit: 100 });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((m) => m.modTags.includes('attribute'))).toBe(true);
    });

    it('honours the limit parameter', () => {
      const hits = searchMods({ statContains: 'Life', limit: 5 });
      expect(hits.length).toBeLessThanOrEqual(5);
    });

    it('limit=0 disables the cap (results may be large)', () => {
      const capped = searchMods({ group: 'IncreasedLife', limit: 5 });
      const all = searchMods({ group: 'IncreasedLife', limit: 0 });
      expect(all.length).toBeGreaterThan(capped.length);
    });

    it('returns empty when no mod matches the filters', () => {
      const hits = searchMods({ statContains: 'definitely-not-a-real-stat-text', limit: 10 });
      expect(hits).toEqual([]);
    });
  });
});
