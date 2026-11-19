import { describe, it, expect, jest } from '@jest/globals';
import { resolveBuildDps } from '../../src/utils/buildDps';
import { handleCheckBossReadiness } from '../../src/handlers/bossReadinessHandlers';

describe('resolveBuildDps', () => {
  it('uses Full DPS when the player deals none of it', () => {
    expect(resolveBuildDps({ TotalDPS: 0, CombinedDPS: 0, MinionCombinedDPS: 700, FullDPS: 14_000 }))
      .toEqual({ value: 14_000, label: 'Full DPS' });
  });

  it('uses minion DPS when no group is flagged for Full DPS', () => {
    expect(resolveBuildDps({ CombinedDPS: 0, MinionTotalDPS: 300, MinionCombinedDPS: 700, FullDPS: 0 }))
      .toEqual({ value: 700, label: 'Minion DPS' });
  });

  it('keeps the main skill for a normal player build', () => {
    expect(resolveBuildDps({ TotalDPS: 5_000, CombinedDPS: 6_000, FullDPS: 6_500 }))
      .toEqual({ value: 6_000, label: 'DPS' });
  });

  it('returns zero for missing stats', () => {
    expect(resolveBuildDps(null)).toEqual({ value: 0, label: 'DPS' });
  });
});

describe('handleCheckBossReadiness', () => {
  it('passes the DPS check for a minion build on Full DPS', async () => {
    const getStats = jest.fn<() => Promise<any>>().mockResolvedValue({
      Life: 7_000, TotalEHP: 100_000, TotalDPS: 0, CombinedDPS: 0, FullDPS: 14_000_000,
      FireResist: 75, ColdResist: 75, LightningResist: 75, ChaosResist: 0,
    });
    const context = {
      getLuaClient: () => ({ getStats }) as any,
      ensureLuaClient: async () => {},
    };
    const text = (await handleCheckBossReadiness(context, 'pinnacle')).content[0].text;
    expect(text).toContain('✅ DPS: 14,000,000 (Full DPS)');
    expect(text).not.toContain('DPS is dangerously low');
  });
});
