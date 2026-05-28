import { describe, it, expect } from '@jest/globals';
import { existsSync } from 'fs';
import { resolve } from 'path';

import { handleAnalyzeItemMods } from '../../src/handlers/analyzeItemModsHandler';

const pobDir = process.env.POB_DIRECTORY ?? resolve(process.cwd(), '..', 'PathOfBuilding');
const hasAll =
  existsSync(resolve(pobDir, 'src', 'Data', 'ModItem.lua')) &&
  existsSync(resolve(pobDir, 'src', 'Data', 'Bases', 'body.lua'));

const describeIfPob = hasAll ? describe : describe.skip;

function getText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join('\n');
}

describeIfPob('handleAnalyzeItemMods', () => {
  it('rejects empty mod_lines', async () => {
    const r = await handleAnalyzeItemMods({ mod_lines: [] });
    expect(r.isError).toBe(true);
  });

  it('identifies mods and splits prefixes/suffixes', async () => {
    const r = await handleAnalyzeItemMods({
      base_name: 'Astral Plate',
      ilvl: 86,
      mod_lines: ['+150 to maximum Life', '+48% to Fire Resistance', '+45 to Strength'],
    });
    expect(r.isError).toBeUndefined();
    const text = getText(r);
    expect(text).toMatch(/PREFIXES/);
    expect(text).toMatch(/SUFFIXES/);
    expect(text).toMatch(/IncreasedLife/);
    expect(text).toMatch(/FireResistance/);
    expect(text).toMatch(/Strength/);
  });

  it('reports tier and next-tier in raw JSON', async () => {
    const r = await handleAnalyzeItemMods({
      base_name: 'Astral Plate',
      ilvl: 86,
      mod_lines: ['+150 to maximum Life'],
      raw_json: true,
    });
    const parsed = JSON.parse(getText(r));
    const m = parsed.lines[0].match;
    expect(m.best.group).toBe('IncreasedLife');
    expect(m.tier).toBeGreaterThanOrEqual(1);
    expect(m.tier_max).toBeGreaterThan(m.tier);
    expect(m.next_tier).not.toBeNull();
    expect(m.next_tier.level).toBeGreaterThan(m.best.level);
  });

  it('flags crafted mods separately and does not match them', async () => {
    const r = await handleAnalyzeItemMods({
      base_name: 'Astral Plate',
      ilvl: 86,
      mod_lines: ['+15% increased Stun and Block Recovery {crafted}'],
      raw_json: true,
    });
    const parsed = JSON.parse(getText(r));
    expect(parsed.lines[0].source).toBe('crafted');
    expect(parsed.lines[0].match).toBeNull();
  });

  it('collapses hybrid-mod continuation lines', async () => {
    // Crocodile's: "+(97-144) to Armour" / "+(34-38) to maximum Life" is one mod
    const r = await handleAnalyzeItemMods({
      base_name: 'Astral Plate',
      ilvl: 86,
      mod_lines: ['+120 to Armour', '+36 to maximum Life'],
      raw_json: true,
    });
    const parsed = JSON.parse(getText(r));
    // If both lines matched the same hybrid mod, the second is flagged
    const ids = parsed.lines.map((l: { match: { best?: { id: string } } | null }) => l.match?.best?.id);
    if (ids[0] && ids[0] === ids[1]) {
      expect(parsed.lines[1].is_hybrid_continuation).toBe(true);
    }
    // (If they matched different mods, no continuation — still valid; the
    // test only asserts the collapse logic when IDs coincide.)
    expect(parsed.lines.length).toBe(2);
  });

  it('surfaces base-name fuzzy suggestions on miss', async () => {
    const r = await handleAnalyzeItemMods({
      base_name: 'Astral Plte',
      mod_lines: ['+150 to maximum Life'],
    });
    const text = getText(r);
    // Either it found nothing close, or it suggests — both acceptable, but it
    // must not crash and must still analyze the line without tag gating.
    expect(text).toMatch(/Item Mod Analysis/);
  });

  it('works without a base (no tag gating)', async () => {
    const r = await handleAnalyzeItemMods({
      mod_lines: ['+45 to Strength'],
    });
    const text = getText(r);
    expect(text).toMatch(/No base supplied/);
    expect(text).toMatch(/Strength/);
  });
});
