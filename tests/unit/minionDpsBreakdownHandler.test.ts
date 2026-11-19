import { describe, it, expect, jest } from '@jest/globals';
import { handleMinionDpsBreakdown } from '../../src/handlers/minionDpsBreakdownHandler';
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

describe('handleMinionDpsBreakdown', () => {
  it('renders the per-skill table with count multiplication and shares', async () => {
    const client = {
      getFullDpsBreakdown: jest.fn<() => Promise<any>>().mockResolvedValue({
        skills: [
          { name: 'Summon Holy Relic', dps: 120_000, count: 4, skillPart: 'Nova' },
          { name: 'Raise Zombie', dps: 30_000, count: 10 },
          { name: 'Best Ignite DPS', dps: 15_000, count: 1, source: 'Summon Holy Relic' },
        ],
        fullDPS: 795_000,
        fullDotDPS: 15_000,
        playerDPS: 8_000,
      }),
    };
    const result = await handleMinionDpsBreakdown(makeContext(client));
    const text = result.content[0].text;

    expect(text).toContain('Full DPS total: 795,000');
    // Holy Relic: 120k × 4 = 480k
    const relicRow = text.split('\n').find((l) => l.includes('Summon Holy Relic (Nova)'));
    expect(relicRow).toContain('| 4 |');
    expect(relicRow).toContain('480,000');
    // Zombies: 30k × 10 = 300k, sorted below relics
    const zombieRow = text.split('\n').find((l) => l.includes('Raise Zombie'));
    expect(zombieRow).toContain('300,000');
    expect(text.indexOf('Holy Relic')).toBeLessThan(text.indexOf('Raise Zombie'));
    // Shares: 480/795 ≈ 60.38%
    expect(relicRow).toMatch(/60\.\d+%/);
    // Ailment row keeps its source attribution
    expect(text).toContain('← Summon Holy Relic');
    // The two structural warnings
    expect(text).toContain('Count');
    expect(text).toContain('perfect minion uptime');
  });

  it('estimates realistic Full DPS, discounting only minion-driven damage', async () => {
    const client = {
      getFullDpsBreakdown: jest.fn<() => Promise<any>>().mockResolvedValue({
        skills: [
          { name: 'Summon Raging Spirit', dps: 3_000, count: 20, skillPart: 'Raging Spirit: Melee' },
          { name: 'Fireball', dps: 20_000, count: 1, skillPart: '' },
          { name: 'Full Poison DPS', dps: 40_000, count: 1 },
        ],
        fullDPS: 120_000,
        fullDotDPS: 40_000,
        playerDPS: 20_000,
      }),
    };
    const text = (await handleMinionDpsBreakdown(makeContext(client))).content[0].text;
    // Poison splits 60:20, so minions drive 60k + 30k = 90k and the other 30k is untouched.
    expect(text).toContain('Minion-driven damage: 90,000 of 120,000 Full DPS (75%)');
    expect(text).toContain('| Stationary target, ranged or triggered minions | 90-95% | 111,000 - 115,500 |');
    expect(text).toContain('| Moving target, melee minions | 60-80% | 84,000 - 102,000 |');
  });

  it('omits the estimate when no row is a minion', async () => {
    const client = {
      getFullDpsBreakdown: jest.fn<() => Promise<any>>().mockResolvedValue({
        skills: [{ name: 'Fireball', dps: 20_000, count: 1, skillPart: '' }],
        fullDPS: 20_000,
        fullDotDPS: 0,
        playerDPS: 20_000,
      }),
    };
    const text = (await handleMinionDpsBreakdown(makeContext(client))).content[0].text;
    expect(text).not.toContain('Realistic estimate');
  });

  it('gives setup guidance when no groups are flagged for Full DPS', async () => {
    const client = {
      getFullDpsBreakdown: jest.fn<() => Promise<any>>().mockResolvedValue({
        skills: [],
        fullDPS: 0,
        fullDotDPS: 0,
        playerDPS: 42_000,
      }),
    };
    const result = await handleMinionDpsBreakdown(makeContext(client));
    const text = result.content[0].text;
    expect(text).toContain('No socket groups are flagged');
    expect(text).toContain('Include in Full DPS');
    expect(text).toContain('does NOT auto-multiply');
    expect(text).toContain('42,000');
  });

  it('errors with relaunch guidance when the Lua action is missing', async () => {
    const result = await handleMinionDpsBreakdown(makeContext({})).catch((e: Error) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('LaunchPoBWithAPI');
  });
});
