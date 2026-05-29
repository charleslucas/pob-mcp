import { describe, it, expect } from '@jest/globals';
import { handleGetCalcBreakdown } from '../../src/handlers/calcBreakdownHandler';

function getText(r: { content: Array<{ type: string; text: string }> }): string {
  return r.content.map((c) => c.text).join('\n');
}

function makeContext(breakdown: unknown) {
  return {
    ensureLuaClient: async () => {},
    getLuaClient: () =>
      ({ getCalcBreakdown: async () => breakdown }) as unknown as import('../../src/pobLuaBridge').AnyLuaClient,
  };
}

describe('handleGetCalcBreakdown', () => {
  it('lists available stats when no stat is given', async () => {
    const ctx = makeContext({ available: ['AverageDamage', 'TotalDPS', 'Speed', 'CritChance'] });
    const r = await handleGetCalcBreakdown(ctx, {});
    const text = getText(r);
    expect(text).toMatch(/Stats with a breakdown available/);
    expect(text).toMatch(/AverageDamage/);
    expect(text).toMatch(/TotalDPS/);
  });

  it('reports not-found with the available list', async () => {
    const ctx = makeContext({ stat: 'Bogus', found: false, available: ['TotalDPS'] });
    const r = await handleGetCalcBreakdown(ctx, { stat: 'Bogus' });
    const text = getText(r);
    expect(text).toMatch(/No breakdown found for "Bogus"/);
    expect(text).toMatch(/TotalDPS/);
  });

  it('renders the breakdown lines for a found stat', async () => {
    const ctx = makeContext({
      stat: 'AverageDamage',
      found: true,
      actor: 'player',
      output_value: 18532,
      lines: [
        'Hit Damage:',
        '  120 to 180 (base)',
        '  x 6.40 (increased/reduced)',
        '  x 1.85 (more/less)',
        '  = 18532',
      ],
    });
    const r = await handleGetCalcBreakdown(ctx, { stat: 'AverageDamage' });
    const text = getText(r);
    expect(text).toMatch(/PoB calc breakdown: AverageDamage/);
    expect(text).toMatch(/Output value: 18532/);
    expect(text).toMatch(/increased\/reduced/);
    expect(text).toMatch(/more\/less/);
    expect(text).toMatch(/Source: PoB's own Calcs-tab breakdown/);
  });

  it('returns raw JSON when requested', async () => {
    const ctx = makeContext({ stat: 'TotalDPS', found: true, lines: ['= 100'] });
    const r = await handleGetCalcBreakdown(ctx, { stat: 'TotalDPS', raw_json: true });
    const parsed = JSON.parse(getText(r));
    expect(parsed.stat).toBe('TotalDPS');
    expect(parsed.lines).toContain('= 100');
  });

  it('handles an empty-lines breakdown gracefully', async () => {
    const ctx = makeContext({ stat: 'Speed', found: true, lines: [] });
    const r = await handleGetCalcBreakdown(ctx, { stat: 'Speed' });
    expect(getText(r)).toMatch(/empty breakdown/);
  });
});
