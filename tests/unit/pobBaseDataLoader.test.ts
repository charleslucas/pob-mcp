import { describe, it, expect } from '@jest/globals';
import { existsSync } from 'fs';
import { resolve } from 'path';

import {
  ensureBasesLoaded,
  findBasesMatching,
  getBase,
  getBaseCount,
  getBasesByTag,
} from '../../src/services/pobBaseDataLoader';

const pobDir = process.env.POB_DIRECTORY ?? resolve(process.cwd(), '..', 'PathOfBuilding');
const hasBaseData = existsSync(resolve(pobDir, 'src', 'Data', 'Bases', 'body.lua'));

const describeIfPob = hasBaseData ? describe : describe.skip;

describeIfPob('pobBaseDataLoader', () => {
  it('parses every equipment base file and exposes hundreds of bases', () => {
    ensureBasesLoaded();
    // ~981 across all equipment files — well above any sane lower bound
    expect(getBaseCount()).toBeGreaterThan(400);
  });

  it('returns Astral Plate with the expected tag chain', () => {
    const b = getBase('Astral Plate');
    expect(b).not.toBeNull();
    if (!b) return;
    expect(b.type).toBe('Body Armour');
    expect(b.subType).toBe('Armour');
    expect(b.tags).toContain('armour');
    expect(b.tags).toContain('body_armour');
    expect(b.tags).toContain('str_armour');
    expect(b.req.level).toBeDefined();
    expect(b.implicit).toMatch(/Elemental Resistances/);
  });

  it('is case-insensitive on lookup', () => {
    expect(getBase('astral plate')).not.toBeNull();
    expect(getBase('ASTRAL PLATE')).not.toBeNull();
    expect(getBase('Astral Plate')).not.toBeNull();
  });

  it('returns null for unknown bases', () => {
    expect(getBase('Not A Real Base Item Name')).toBeNull();
  });

  it('findBasesMatching surfaces partial matches', () => {
    const hits = findBasesMatching('hubris', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((b) => b.name === 'Hubris Circlet')).toBe(true);
  });

  it('getBasesByTag returns every base sharing the tag', () => {
    const rings = getBasesByTag('ring');
    expect(rings.length).toBeGreaterThan(15); // PoE has many ring bases
    expect(rings.every((b) => b.type === 'Ring')).toBe(true);
  });
});
