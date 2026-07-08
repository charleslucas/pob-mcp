import { describe, it, expect, jest } from '@jest/globals';
import { handleComputeStatWeights } from '../../src/handlers/statWeightsHandler';
import type { LuaHandlerContext } from '../../src/handlers/luaHandlers';

function makeContext(luaClient: any = null): LuaHandlerContext {
  return {
    pobDirectory: '/builds',
    luaEnabled: true,
    getLuaClient: jest.fn<() => any>().mockReturnValue(luaClient),
    ensureLuaClient: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    stopLuaClient: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

function makeProbeResult(mods: string[]) {
  return {
    base: { CombinedDPS: 2_000_000, TotalEHP: 37_000 },
    slot: 'Ring 1',
    carrier: 'Ghoul Grip',
    results: mods.map((mod) => {
      if (mod.includes('maximum Life')) return { mod, dpsDelta: 0, ehpDelta: 900, recognized: true };
      if (mod.includes('Critical Strike Multiplier')) return { mod, dpsDelta: 150_000, ehpDelta: 0, recognized: true };
      if (mod.includes('Cast Speed')) return { mod, dpsDelta: 0, ehpDelta: 0, recognized: true };
      if (mod.includes('nonsense')) return { mod, dpsDelta: 0, ehpDelta: 0, recognized: false };
      return { mod, dpsDelta: 10_000, ehpDelta: 5, recognized: true };
    }),
    evaluated: mods.length,
    failed: 0,
  };
}

function makeLuaClient() {
  const client = {
    probeStatWeights: jest.fn<(p: { slot?: string; mods: string[] }) => Promise<any>>(),
  };
  client.probeStatWeights.mockImplementation(async (p) => makeProbeResult(p.mods));
  return client;
}

describe('handleComputeStatWeights', () => {
  it('runs the default battery and reports per-unit weights sorted by DPS impact', async () => {
    const client = makeLuaClient();
    const result = await handleComputeStatWeights(makeContext(client));
    const text = result.content[0].text;

    // Default battery sent to the bridge
    const sentMods = client.probeStatWeights.mock.calls[0][0].mods;
    expect(sentMods.length).toBeGreaterThanOrEqual(12);
    expect(sentMods).toEqual(expect.arrayContaining(['+50 to maximum Life', '+25% to Global Critical Strike Multiplier']));

    expect(text).toContain('Baseline: DPS 2,000,000');
    expect(text).toContain('Ghoul Grip');
    // Per-unit math: +25% crit multi probe → 150000/25 = 6000 per 1% crit multi
    expect(text).toContain('6,000 per 1% crit multi');
    // Life probe: 900 EHP / 50 = 18 EHP per 1 life (EHP Δ then per-unit column)
    const lifeRow = text.split('\n').find((l) => l.includes('+50 to maximum Life'));
    expect(lifeRow).toContain('| 900 | 18 |');
    // Crit multi (7.5% of base DPS) should rank above flat-10k probes
    const critIdx = text.indexOf('Critical Strike Multiplier');
    const lifeIdx = text.indexOf('+50 to maximum Life');
    expect(critIdx).toBeGreaterThan(-1);
    expect(critIdx).toBeLessThan(lifeIdx);
  });

  it('passes custom mods and slot through to the bridge', async () => {
    const client = makeLuaClient();
    await handleComputeStatWeights(makeContext(client), 'Amulet', ['5% increased Cast Speed']);
    const call = client.probeStatWeights.mock.calls[0][0];
    expect(call.slot).toBe('Amulet');
    expect(call.mods).toEqual(['5% increased Cast Speed']);
  });

  it('flags unrecognized probe mods instead of reporting them as zero-value', async () => {
    const client = makeLuaClient();
    const result = await handleComputeStatWeights(makeContext(client), undefined, [
      '+50 to maximum Life',
      'totally nonsense mod line',
    ]);
    const text = result.content[0].text;
    expect(text).toContain('1 probe(s) not usable');
    expect(text).toContain('totally nonsense mod line');
    // The unrecognized probe must NOT appear as a data row in the table
    const tableRows = text.split('\n').filter((l) => l.startsWith('| ') && l.includes('nonsense'));
    expect(tableRows).toHaveLength(0);
  });

  it('errors with reinstall guidance when the Lua action is missing (old API files)', async () => {
    const oldClient = {}; // no probeStatWeights method
    const result = await handleComputeStatWeights(makeContext(oldClient)).catch((e: Error) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('InstallTcpApi');
  });

  it('flags an all-zero battery as suspect instead of presenting it as real weights', async () => {
    const client = {
      probeStatWeights: jest.fn<(p: any) => Promise<any>>().mockResolvedValue({
        base: { CombinedDPS: 2_000_000, TotalEHP: 37_000 },
        slot: 'Ring 1',
        carrier: 'Entropy Grip',
        results: Array.from({ length: 15 }, (_, i) => ({ mod: `probe ${i}`, dpsDelta: 0, ehpDelta: 0, recognized: true })),
        evaluated: 15,
        failed: 0,
      }),
    };
    const result = await handleComputeStatWeights(makeContext(client));
    expect(result.content[0].text).toContain('SUSPECT RESULT');
    expect(result.content[0].text).toContain('Do NOT record');
  });

  it('mentions trade-weight and build-profile usage in the output', async () => {
    const client = makeLuaClient();
    const result = await handleComputeStatWeights(makeContext(client));
    expect(result.content[0].text).toContain('find_weighted_trade_items');
    expect(result.content[0].text).toContain('build-profile.md');
  });
});
