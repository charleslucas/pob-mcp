import { describe, it, expect } from '@jest/globals';
import { existsSync } from 'fs';
import { resolve } from 'path';

import {
  ensureCraftDataLoaded,
  findEssencesMatching,
  getEssence,
  getEssenceCount,
  getMasterCraftCount,
  matchMasterCraft,
  resolveEssenceMods,
  searchEssencesByStat,
  searchMasterCrafts,
} from '../../src/services/pobCraftDataLoader';

const pobDir = process.env.POB_DIRECTORY ?? resolve(process.cwd(), '..', 'PathOfBuilding');
const hasData =
  existsSync(resolve(pobDir, 'src', 'Data', 'ModMaster.lua')) &&
  existsSync(resolve(pobDir, 'src', 'Data', 'Essence.lua'));

const describeIfPob = hasData ? describe : describe.skip;

describeIfPob('pobCraftDataLoader', () => {
  it('loads master crafts and essences', () => {
    ensureCraftDataLoaded();
    expect(getMasterCraftCount()).toBeGreaterThan(100);
    expect(getEssenceCount()).toBeGreaterThan(50);
  });

  describe('searchMasterCrafts', () => {
    it('finds movement speed bench crafts on Boots', () => {
      const hits = searchMasterCrafts({ statContains: 'Movement Speed', itemType: 'Boots' });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((mc) => mc.types.includes('Boots'))).toBe(true);
      expect(hits.every((mc) => mc.statLines.some((s) => /movement speed/i.test(s)))).toBe(true);
    });

    it('filters by prefix/suffix type', () => {
      const hits = searchMasterCrafts({ statContains: 'Resistance', type: 'Suffix', limit: 30 });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((mc) => mc.type === 'Suffix')).toBe(true);
    });

    it('respects item_type gating', () => {
      const ringCrafts = searchMasterCrafts({ itemType: 'Ring', limit: 0 });
      expect(ringCrafts.every((mc) => mc.types.includes('Ring'))).toBe(true);
    });
  });

  describe('matchMasterCraft', () => {
    it('identifies a bench-crafted hybrid resistance line', () => {
      const mc = matchMasterCraft('+30% to Cold and Lightning Resistances', 'Body Armour');
      expect(mc).not.toBeNull();
      expect(mc?.group).toBe('ColdAndLightningResistance');
    });

    it('returns null for a non-bench-craft line', () => {
      const mc = matchMasterCraft('Florble gnarp wibble', 'Body Armour');
      expect(mc).toBeNull();
    });
  });

  describe('essences', () => {
    it('looks up an essence case-insensitively', () => {
      expect(getEssence('Deafening Essence of Greed')).not.toBeNull();
      expect(getEssence('deafening essence of greed')).not.toBeNull();
    });

    it('returns null for unknown essence', () => {
      expect(getEssence('Essence of Nonexistence')).toBeNull();
    });

    it('resolves essence mods to ModItem.lua entries', () => {
      const resolved = resolveEssenceMods('Deafening Essence of Greed', 'Body Armour');
      expect(resolved.length).toBe(1);
      expect(resolved[0].mod).not.toBeNull();
      expect(resolved[0].mod?.statLines.some((s) => /maximum Life/i.test(s))).toBe(true);
    });

    it('resolves all item types when none specified', () => {
      const resolved = resolveEssenceMods('Deafening Essence of Greed');
      expect(resolved.length).toBeGreaterThan(5);
      // Most entries should resolve to a real mod
      expect(resolved.filter((r) => r.mod !== null).length).toBeGreaterThan(5);
    });

    it('findEssencesMatching surfaces partial-name matches', () => {
      const hits = findEssencesMatching('Greed', 10);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((e) => /greed/i.test(e.name))).toBe(true);
    });

    it('searchEssencesByStat finds essences providing a stat', () => {
      const hits = searchEssencesByStat('to maximum Life', 20);
      expect(hits.length).toBeGreaterThan(0);
      // Greed essences provide life on armour pieces
      expect(hits.some((h) => /greed/i.test(h.essence.name))).toBe(true);
      expect(hits.every((h) => h.matchingTypes.length > 0)).toBe(true);
    });
  });
});
