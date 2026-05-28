import { describe, it, expect } from '@jest/globals';
import { handleGetStatBreakdown } from '../../src/handlers/statBreakdownHandler';

function getText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join('\n');
}

function makeContext(breakdown: unknown) {
  return {
    ensureLuaClient: async () => {},
    getLuaClient: () =>
      ({
        getStatBreakdown: async () => breakdown,
      }) as unknown as import('../../src/pobLuaBridge').AnyLuaClient,
  };
}

describe('handleGetStatBreakdown', () => {
  it('rejects missing stat', async () => {
    const r = await handleGetStatBreakdown(makeContext({}), { stat: '' });
    expect(r.isError).toBe(true);
  });

  it('formats contributions grouped by mod type', async () => {
    const breakdown = {
      stat: 'Life',
      actor: 'player',
      output_value: 4200,
      contributions: [
        { modType: 'BASE', value: 99, source: 'Tree:55834', name: 'Life', flags: 0 },
        { modType: 'BASE', value: 38, source: 'Item:5:Belt', name: 'Life', flags: 0 },
        { modType: 'INC', value: 8, source: 'Tree:12345', name: 'Life', flags: 0 },
        { modType: 'INC', value: 12, source: 'Item', name: 'Life', flags: 0 },
        { modType: 'BASE', value: 50, source: 'Base', name: 'Life', flags: 0 },
      ],
    };
    const r = await handleGetStatBreakdown(makeContext(breakdown), { stat: 'Life' });
    const text = getText(r);
    expect(text).toMatch(/Breakdown: Life \(player\)/);
    expect(text).toMatch(/Current output value: 4200/);
    expect(text).toMatch(/--- BASE/);
    expect(text).toMatch(/--- INC/);
    // Source humanizing: Item slot label surfaces
    expect(text).toMatch(/Item: Belt/);
    expect(text).toMatch(/Base \(innate\)/);
    // INC values rendered as percentages
    expect(text).toMatch(/\+12%/);
  });

  it('resolves Tree: sources to passive node names when available', async () => {
    // node 55834 may or may not exist depending on tree version; the handler
    // must at least produce a "Passive" label and not crash.
    const breakdown = {
      stat: 'Life',
      actor: 'player',
      output_value: 100,
      contributions: [{ modType: 'BASE', value: 10, source: 'Tree:55834', name: 'Life', flags: 0 }],
    };
    const r = await handleGetStatBreakdown(makeContext(breakdown), { stat: 'Life' });
    expect(getText(r)).toMatch(/Passive/);
  });

  it('handles an empty contribution list with guidance', async () => {
    const breakdown = { stat: 'Wibble', actor: 'player', output_value: null, contributions: [] };
    const r = await handleGetStatBreakdown(makeContext(breakdown), { stat: 'Wibble' });
    const text = getText(r);
    expect(text).toMatch(/No contributing modifiers/);
    expect(text).toMatch(/skill-conditional|internal mod name/);
  });

  it('returns raw JSON with humanized sources when requested', async () => {
    const breakdown = {
      stat: 'FireResistance',
      actor: 'player',
      output_value: 75,
      contributions: [{ modType: 'BASE', value: 48, source: 'Item:3:Helmet', name: 'FireResistance', flags: 0 }],
    };
    const r = await handleGetStatBreakdown(makeContext(breakdown), { stat: 'FireResistance', raw_json: true });
    const parsed = JSON.parse(getText(r));
    expect(parsed.stat).toBe('FireResistance');
    expect(parsed.contributions[0].sourceHuman).toMatch(/Item: Helmet/);
  });
});
