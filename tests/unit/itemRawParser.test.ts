import { describe, it, expect } from '@jest/globals';
import { parseItemRawMods, parseItemLevel } from '../../src/utils/itemRawParser';

// A representative PoB raw item block (Body Armour with mixed mod sources).
const RAW = `Rarity: RARE
Doom Shell
Astral Plate
Item Level: 84
Implicits: 1
+8% to all Elemental Resistances
+120 to maximum Life
+45% to Fire Resistance
{crafted}+15% to Cold and Lightning Resistances
{fractured}+30 to Strength
Corrupted`;

describe('parseItemRawMods', () => {
  it('separates implicit from explicit mods', () => {
    const mods = parseItemRawMods(RAW);
    const implicit = mods.filter((m) => m.type === 'implicit');
    expect(implicit.length).toBe(1);
    expect(implicit[0].line).toMatch(/all Elemental Resistances/);
  });

  it('tags crafted and fractured mods', () => {
    const mods = parseItemRawMods(RAW);
    const crafted = mods.find((m) => m.type === 'crafted');
    const fractured = mods.find((m) => m.type === 'fractured');
    expect(crafted?.line).toMatch(/Cold and Lightning Resistances/);
    expect(fractured?.line).toMatch(/to Strength/);
  });

  it('strips {tag} markers from display text', () => {
    const mods = parseItemRawMods(RAW);
    expect(mods.every((m) => !m.line.includes('{'))).toBe(true);
  });

  it('skips trailer lines like Corrupted', () => {
    const mods = parseItemRawMods(RAW);
    expect(mods.every((m) => m.line !== 'Corrupted')).toBe(true);
  });

  it('returns empty for undefined/empty raw', () => {
    expect(parseItemRawMods(undefined)).toEqual([]);
    expect(parseItemRawMods('')).toEqual([]);
  });
});

describe('parseItemLevel', () => {
  it('extracts the item level', () => {
    expect(parseItemLevel(RAW)).toBe(84);
  });

  it('returns undefined when absent', () => {
    expect(parseItemLevel('Rarity: RARE\nSome Item')).toBeUndefined();
  });
});
