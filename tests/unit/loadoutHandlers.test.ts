import { describe, it, expect, jest } from '@jest/globals';
import {
  handleListLoadouts,
  handleSelectLoadout,
  handleListSkillSets,
  handleSelectConfigSet,
} from '../../src/handlers/luaHandlers';
import type { LuaHandlerContext } from '../../src/handlers/luaHandlers';

function makeContext(luaClient: any): LuaHandlerContext {
  return {
    pobDirectory: '/builds',
    luaEnabled: true,
    getLuaClient: jest.fn<() => any>().mockReturnValue(luaClient),
    ensureLuaClient: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    stopLuaClient: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

const set = (id: number, title: string, active = false) => ({ id, title, base: title, active });

describe('handleListLoadouts', () => {
  it('lists each loadout by title and flags incomplete ones', async () => {
    const client = {
      listLoadouts: jest.fn<() => Promise<any>>().mockResolvedValue({
        loadouts: [
          {
            name: 'Mapping', title: 'Mapping {1}', complete: true, active: true,
            treeSpec: set(2, 'Mapping {1}', true), itemSet: set(2, 'Mapping {1}', true),
            skillSet: set(1, 'Default', true), configSet: set(1, 'Default', true),
          },
          {
            name: 'Orphan', title: 'Orphan', complete: false, active: false,
            treeSpec: set(3, 'Orphan'), itemSet: null, skillSet: set(1, 'Default', true), configSet: set(1, 'Default', true),
          },
        ],
        active: { treeSpecIndex: 2, itemSetId: 2, skillSetId: 1, configSetId: 1 },
      }),
    };
    const text = (await handleListLoadouts(makeContext(client))).content[0].text;
    expect(text).toContain('▶ [1] Mapping {1}');
    expect(text).toContain('[2] Orphan');
    expect(text).toContain('⚠ incomplete');
    expect(text).toContain('items — no match');
  });
});

describe('handleSelectLoadout', () => {
  it('passes allowPartial only when requested', async () => {
    const selectLoadout = jest.fn<(p: any) => Promise<any>>().mockResolvedValue({
      selected: {
        name: 'Mapping', title: 'Mapping {1}', complete: true, missing: [],
        treeSpec: set(2, 'Mapping {1}', true), itemSet: set(2, 'Mapping {1}', true),
        skillSet: set(1, 'Default', true), configSet: set(1, 'Default', true),
      },
    });
    const ctx = makeContext({ selectLoadout });
    const text = (await handleSelectLoadout(ctx, 'Mapping')).content[0].text;
    expect(selectLoadout).toHaveBeenLastCalledWith({ name: 'Mapping' });
    expect(text).toContain('Switched to loadout "Mapping {1}"');
    expect(text).not.toContain('incomplete');

    await handleSelectLoadout(ctx, 'Mapping', undefined, true);
    expect(selectLoadout).toHaveBeenLastCalledWith({ name: 'Mapping', allowPartial: true });
  });

  it('names the missing families after a partial switch', async () => {
    const client = {
      selectLoadout: jest.fn<() => Promise<any>>().mockResolvedValue({
        selected: {
          name: 'Orphan', title: 'Orphan', complete: false, missing: ['item set'],
          treeSpec: set(3, 'Orphan', true), itemSet: null,
          skillSet: set(1, 'Default', true), configSet: set(1, 'Default', true),
        },
      }),
    };
    const text = (await handleSelectLoadout(makeContext(client), 'Orphan', undefined, true)).content[0].text;
    expect(text).toContain('no matching set — left unchanged');
    expect(text).toContain('incomplete (no matching item set)');
  });

  it('surfaces the refusal for an incomplete loadout', async () => {
    const client = {
      selectLoadout: jest.fn<() => Promise<any>>().mockRejectedValue(
        new Error('loadout "Orphan" is incomplete: no matching item set. Nothing was switched.'),
      ),
    };
    await expect(handleSelectLoadout(makeContext(client), 'Orphan')).rejects.toThrow('Nothing was switched');
  });

  it('requires a name or index', async () => {
    await expect(handleSelectLoadout(makeContext({}), undefined, undefined)).rejects.toThrow('loadout name');
  });
});

describe('skill and config sets', () => {
  it('lists skill sets with the active one marked', async () => {
    const client = {
      listSkillSets: jest.fn<() => Promise<any>>().mockResolvedValue({
        skillSets: [
          { id: 1, title: 'Leveling', socketGroupCount: 4, active: false },
          { id: 2, title: 'Endgame', socketGroupCount: 9, active: true },
        ],
        activeSkillSetId: 2,
      }),
    };
    const text = (await handleListSkillSets(makeContext(client))).content[0].text;
    expect(text).toContain('▶ [2] Endgame — 9 socket group(s)');
    expect(text).toContain('  [1] Leveling');
  });

  it('reports the selected config set', async () => {
    const client = {
      selectConfigSet: jest.fn<(id: number) => Promise<any>>().mockResolvedValue({
        configSets: [{ id: 2, title: 'Pinnacle', customModCount: 0, active: true }],
        activeConfigSetId: 2,
      }),
    };
    const text = (await handleSelectConfigSet(makeContext(client), 2)).content[0].text;
    expect(client.selectConfigSet).toHaveBeenCalledWith(2);
    expect(text).toContain('Switched to Config Set 2 — Pinnacle');
  });
});
