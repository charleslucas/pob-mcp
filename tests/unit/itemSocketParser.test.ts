import { describe, it, expect } from '@jest/globals';
import { parseItemSockets, socketColorName } from '../../src/utils/itemSocketParser';

// PoB serialises the socket layout on a "Sockets:" line within the item text.
const GLOVES = `Rarity: UNIQUE
Triad Grip
Mesh Gloves
Item Level: 73
Sockets: R-G-B-W
Minions convert 25% of Physical Damage to Fire Damage per Red Socket`;

const CHEST_6L = `Rarity: RARE
Some Chest
Astral Plate
Sockets: R-R-R-G-G-B`;

const SPLIT_GROUPS = `Rarity: RARE
Split Item
Sockets: R-G-B G-G R`;

describe('parseItemSockets', () => {
  it('parses a 4-socket linked group with mixed colours', () => {
    const s = parseItemSockets(GLOVES)!;
    expect(s).not.toBeNull();
    expect(s.total).toBe(4);
    expect(s.maxLink).toBe(4);
    expect(s.groups).toEqual([['R', 'G', 'B', 'W']]);
    expect(s.colorCounts).toMatchObject({ R: 1, G: 1, B: 1, W: 1 });
    expect(s.abyssal).toBe(0);
  });

  it('parses a 6-link', () => {
    const s = parseItemSockets(CHEST_6L)!;
    expect(s.total).toBe(6);
    expect(s.maxLink).toBe(6);
    expect(s.colorCounts).toMatchObject({ R: 3, G: 2, B: 1 });
  });

  it('separates unlinked groups (space) from linked (dash)', () => {
    const s = parseItemSockets(SPLIT_GROUPS)!;
    expect(s.groups).toEqual([['R', 'G', 'B'], ['G', 'G'], ['R']]);
    expect(s.total).toBe(6);
    expect(s.maxLink).toBe(3);
  });

  it('counts abyssal sockets', () => {
    const s = parseItemSockets('Rarity: RARE\nBelt\nSockets: A A')!;
    expect(s.total).toBe(2);
    expect(s.abyssal).toBe(2);
    expect(s.maxLink).toBe(1);
  });

  it('returns null for an item with no Sockets line', () => {
    expect(parseItemSockets('Rarity: RARE\nOnyx Amulet\n+30 to all Attributes')).toBeNull();
    expect(parseItemSockets('')).toBeNull();
    expect(parseItemSockets(undefined)).toBeNull();
  });

  it('maps colour codes to names', () => {
    expect(socketColorName('R')).toBe('Red');
    expect(socketColorName('A')).toBe('Abyssal');
  });
});
