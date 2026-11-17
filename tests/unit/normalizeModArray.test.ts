import { describe, it, expect } from '@jest/globals';
import { normalizeModArray } from '../../src/services/tradeClient';

describe('normalizeModArray', () => {
  it('passes plain strings through', () => {
    expect(normalizeModArray(['+10 to Strength'])).toEqual(['+10 to Strength']);
  });
  it('reads description from object-style mods', () => {
    expect(normalizeModArray([{ description: '+20 to Dexterity', hash: 'x', mods: [] }])).toEqual(['+20 to Dexterity']);
  });
  it('returns [] for non-arrays', () => {
    expect(normalizeModArray(undefined)).toEqual([]);
  });
});
