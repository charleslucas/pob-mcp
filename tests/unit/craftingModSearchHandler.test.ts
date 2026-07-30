import { describe, it, expect } from '@jest/globals';
import { existsSync } from 'fs';
import { resolve } from 'path';

import { handleSearchCraftingMods } from '../../src/handlers/craftingModSearchHandler';

const pobDir = process.env.POB_DIRECTORY ?? resolve(process.cwd(), '..', 'PathOfBuilding');
const hasModData = (existsSync(resolve(pobDir, 'src', 'Data', 'ModExplicit.lua')) || existsSync(resolve(pobDir, 'src', 'Data', 'ModItem.lua')));

const describeIfPob = hasModData ? describe : describe.skip;

function getText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join('\n');
}

describeIfPob('handleSearchCraftingMods', () => {
  it('rejects empty filter input (mod table is too large to dump)', async () => {
    const r = await handleSearchCraftingMods({});
    expect(r.isError).toBe(true);
    expect(getText(r)).toMatch(/at least one filter/i);
  });

  it('returns a human-readable summary by default', async () => {
    const r = await handleSearchCraftingMods({
      stat_contains: 'maximum Life',
      type: 'Prefix',
      min_level: 70,
      limit: 3,
    });
    expect(r.isError).toBeUndefined();
    const text = getText(r);
    expect(text).toMatch(/Crafting mod search/);
    expect(text).toMatch(/Source: PathOfBuilding\/src\/Data\/Mod(Explicit|Item)\.lua/);
    expect(text).toMatch(/maximum Life/i);
  });

  it('returns JSON when raw_json=true', async () => {
    const r = await handleSearchCraftingMods({
      stat_contains: 'maximum Life',
      type: 'Prefix',
      min_level: 80,
      limit: 2,
      raw_json: true,
    });
    const parsed = JSON.parse(getText(r));
    expect(parsed.source).toMatch(/^PathOfBuilding\/src\/Data\/Mod(Explicit|Item)\.lua$/);
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.results[0]).toHaveProperty('id');
    expect(parsed.results[0]).toHaveProperty('statLines');
  });

  it('respects item_tags chain (Astral Plate fire res)', async () => {
    const r = await handleSearchCraftingMods({
      stat_contains: 'Fire Resistance',
      item_tags: ['body_armour', 'armour', 'str_armour'],
      type: 'Suffix',
      limit: 2,
      raw_json: true,
    });
    const parsed = JSON.parse(getText(r));
    expect(parsed.results.length).toBeGreaterThan(0);
    // every result should resolve to weight > 0 for the supplied tags
    for (const r of parsed.results) {
      const tagSet = new Set(['body_armour', 'armour', 'str_armour']);
      let resolved = 0;
      for (const w of r.weights) {
        if (tagSet.has(w.tag)) {
          resolved = w.weight;
          break;
        }
      }
      if (resolved === 0) {
        const def = r.weights.find((w: { tag: string }) => w.tag === 'default');
        resolved = def ? def.weight : 0;
      }
      expect(resolved).toBeGreaterThan(0);
    }
  });

  it('surfaces a friendly empty-results message', async () => {
    const r = await handleSearchCraftingMods({
      stat_contains: 'utterly-impossible-stat-text-xyz',
    });
    expect(r.isError).toBeUndefined();
    expect(getText(r)).toMatch(/No mods matched/);
  });
});
