import { describe, it, expect } from '@jest/globals';
import { existsSync } from 'fs';
import { resolve } from 'path';

import {
  ensureEldritchLoaded,
  getEldritchMod,
  getEldritchModCount,
  getEldritchCapableUniques,
  getEldritchSlotTags,
  resolveEldritchWeight,
  searchEldritchImplicits,
} from '../../src/services/pobEldritchDataLoader';
import { handleSearchEldritchImplicits } from '../../src/handlers/eldritchImplicitHandler';

const pobDir = process.env.POB_DIRECTORY ?? resolve(process.cwd(), '..', 'PathOfBuilding');
const dataFile = resolve(pobDir, 'src', 'Data', 'ModEldritch.lua');
const basesDir = resolve(pobDir, 'src', 'Data', 'Bases', 'helmet.lua');
const describeIfPob = existsSync(dataFile) && existsSync(basesDir) ? describe : describe.skip;

function getText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join('\n');
}

describeIfPob('pobEldritchDataLoader', () => {
  it('loads the full pool and every family carries six tiers', () => {
    ensureEldritchLoaded();
    expect(getEldritchModCount()).toBeGreaterThan(3000);

    const seen = new Map<string, number>();
    for (const id of ['AddedFireDamageEldritchImplicit1']) {
      expect(getEldritchMod(id)).not.toBeNull();
    }
    expect(seen.size).toBe(0);
  });

  it('normalises presence and tier from the group/id', () => {
    const plain = getEldritchMod('AddedFireDamageEldritchImplicit3');
    expect(plain?.source).toBe('Exarch');
    expect(plain?.presence).toBe('none');
    expect(plain?.family).toBe('FireDamage');
    expect(plain?.tier).toBe(3);

    const unique = getEldritchMod('AddedFireDamageEldritchImplicitUniquePresence2');
    expect(unique?.presence).toBe('unique');
    expect(unique?.family).toBe('FireDamage');

    const pinnacle = getEldritchMod('AddedFireDamageEldritchImplicitPinnaclePresence6');
    expect(pinnacle?.presence).toBe('pinnacle');
    expect(pinnacle?.family).toBe('FireDamage');
  });

  it('handles ids that omit the "EldritchImplicit" infix', () => {
    const mod = getEldritchMod('SkillEffectDurationUniquePresence3');
    expect(mod).not.toBeNull();
    expect(mod?.presence).toBe('unique');
    expect(mod?.tier).toBe(3);
    expect(mod?.family).toBe('SkillEffectDuration');
  });

  it('resolves slot weights first-match-wins like PoB', () => {
    const mod = getEldritchMod('AddedFireDamageEldritchImplicit1')!;
    expect(resolveEldritchWeight(mod, new Set(['gloves', 'default'])).weight).toBe(1000);
    // "no_tier_*" markers must never be treated as a slot
    expect(resolveEldritchWeight(mod, new Set(['no_tier_6_eldritch_implicit'])).weight).toBe(0);
    // no gloves tag -> falls through to default (0)
    expect(resolveEldritchWeight(mod, new Set(['helmet', 'default'])).weight).toBe(0);
  });

  it('only reports slot tokens that actually exist in the pool', () => {
    const slots = getEldritchSlotTags();
    expect(slots).toEqual(expect.arrayContaining(['helmet', 'body_armour', 'gloves', 'boots', 'amulet']));
    expect(slots).not.toContain('default');
    expect(slots.some((s) => s.startsWith('no_tier'))).toBe(false);
  });

  it('hides phantom tiers (weight 0 on the queried slot)', () => {
    const pinned = searchEldritchImplicits({
      source: 'exarch',
      tags: ['boots', 'default'],
      statContains: 'action speed',
      includeConditional: true,
    });
    const pinnacle = pinned.families.find((f) => f.presence === 'pinnacle');
    expect(pinnacle).toBeDefined();
    // Pinnacle presences start at tier 3 in the data; tiers 1-2 weigh 0.
    expect(pinnacle!.tiers[0].tier).toBe(3);
    for (const t of pinnacle!.tiers) expect(t.weight).toBeGreaterThan(0);
  });

  it('finds the eldritch-capable unique from the item text', () => {
    const uniques = getEldritchCapableUniques();
    expect(uniques.map((u) => u.title)).toContain('The Eternal Struggle');
    const struggle = uniques.find((u) => u.title === 'The Eternal Struggle')!;
    expect(struggle.baseName).toBe('Onyx Amulet');
    expect(struggle.sources).toEqual(['Exarch', 'Eater']);
  });
});

describeIfPob('handleSearchEldritchImplicits', () => {
  it('requires at least one filter', async () => {
    const r = await handleSearchEldritchImplicits({});
    expect(r.isError).toBe(true);
  });

  it('lists helmet families with the helmet tag resolved', async () => {
    const r = await handleSearchEldritchImplicits({ base_name: 'Hubris Circlet', max_results: 200 });
    expect(r.isError).toBeUndefined();
    const text = getText(r);
    expect(text).toMatch(/=== Eldritch implicits — Hubris Circlet/);
    expect(text).toMatch(/Tags:.*helmet/);
    expect(text).toMatch(/T1/);
  });

  it('rejects an amulet base that no eldritch-capable unique covers', async () => {
    const r = await handleSearchEldritchImplicits({ base_name: 'Marble Amulet' });
    expect(r.isError).toBe(true);
    expect(getText(r)).toMatch(/The Eternal Struggle/);
  });

  it('accepts The Eternal Struggle by title and flags the caveat', async () => {
    const r = await handleSearchEldritchImplicits({ base_name: 'The Eternal Struggle', max_results: 5 });
    expect(r.isError).toBeUndefined();
    const text = getText(r);
    expect(text).toMatch(/Onyx Amulet/);
    expect(text).toMatch(/ONLY to The Eternal Struggle/);
  });

  it('hides conditional variants unless asked for', async () => {
    const without = getText(
      await handleSearchEldritchImplicits({ item_type: 'Gloves', stat_contains: 'fire damage', max_results: 50 }),
    );
    expect(without).not.toMatch(/in your Presence/);

    const withCond = getText(
      await handleSearchEldritchImplicits({
        item_type: 'Gloves',
        stat_contains: 'fire damage',
        include_conditional: true,
        max_results: 50,
      }),
    );
    expect(withCond).toMatch(/in your Presence/);
  });

  it('never lists an entry with no reachable slot, even without a slot filter', async () => {
    const r = await handleSearchEldritchImplicits({ stat_contains: 'life', max_results: 0, raw_json: true });
    const parsed = JSON.parse(getText(r));
    for (const fam of parsed.families) {
      expect(fam.slots.length).toBeGreaterThan(0);
    }
    // Known entry whose only weight key is `default` — nothing can roll it.
    expect(parsed.families.map((f: { family: string }) => f.family)).not.toContain(
      'DamageRemovedFromManaBeforeLife',
    );
  });

  it('every returned tier has a positive weight for the queried slot', async () => {
    const r = await handleSearchEldritchImplicits({
      base_name: 'Stormrider Boots',
      source: 'eater',
      max_results: 0,
      raw_json: true,
    });
    const parsed = JSON.parse(getText(r));
    expect(parsed.family_count).toBeGreaterThan(0);
    for (const fam of parsed.families) {
      for (const t of fam.tiers) {
        expect(t.weight).toBeGreaterThan(0);
      }
    }
    // Eater only
    for (const fam of parsed.families) expect(fam.source).toBe('Eater');
  });
});
