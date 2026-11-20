import { handleCompareItems } from '../../src/handlers/itemCompareHandler.js';

const RING_A = `Item Class: Rings
Rarity: Rare
Test Loop
Ruby Ring
--------
+40 to maximum Life`;

const RING_B = `Item Class: Rings
Rarity: Rare
Other Loop
Ruby Ring
--------
+60 to maximum Life`;

/** A fake PoB: the equipped item's id drives the stats, so restoring is observable. */
function fakePob(startId: number, opts: { hasRestore?: boolean } = {}) {
  let equipped = startId;
  let nextId = 100;
  const calls: string[] = [];
  const statsFor = (id: number) => ({ FullDPS: 1000 + id, TotalEHP: 5000 + id, Life: 3000 + id });
  const lua: any = {
    getItems: async () => [{ slot: 'Ring 1', id: equipped, raw: equipped ? 'ORIGINAL' : '' }],
    getStats: async () => statsFor(equipped),
    getWarnings: async () => ({ warnings: [], count: 0 }),
    addItem: async (_text: string, slot: string) => {
      const id = nextId++;
      calls.push(`add ${slot} -> ${id}`);
      equipped = id;
      return { id };
    },
    clearItemSlot: async () => { calls.push('clear'); equipped = 0; return { cleared: true }; },
  };
  if (opts.hasRestore !== false) {
    lua.restoreItemSlot = async (slot: string, itemId: number, deleteIds: number[]) => {
      calls.push(`restore ${slot} ${itemId} delete ${deleteIds.join(',')}`);
      equipped = itemId;
      return { slot, itemId, deleted: deleteIds };
    };
  } else {
    lua.restoreItemSlot = async () => { throw new Error('unknown action: restore_item_slot'); };
  }
  const context = { getLuaClient: () => lua, ensureLuaClient: async () => {} };
  return { context, calls };
}

describe('handleCompareItems restore', () => {
  it('re-selects the original by id and deletes the candidates', async () => {
    const { context, calls } = fakePob(7);
    const res = await handleCompareItems(context, { slot: 'Ring 1', items: [RING_A, RING_B] });
    expect(calls).toEqual(['add Ring 1 -> 100', 'add Ring 1 -> 101', 'restore Ring 1 7 delete 100,101']);
    expect(res.content[0].text).toContain('original item restored');
    expect(res.content[0].text).not.toContain('remain in the item list');
  });

  it('empties a slot that started empty', async () => {
    const { context, calls } = fakePob(0);
    const res = await handleCompareItems(context, { slot: 'Ring 1', items: [RING_A] });
    expect(calls[calls.length - 1]).toBe('restore Ring 1 0 delete 100');
    expect(res.content[0].text).toContain('slot emptied again');
  });

  it('falls back to re-adding the original on an older PoB API, and says the candidates remain', async () => {
    const { context, calls } = fakePob(7, { hasRestore: false });
    const res = await handleCompareItems(context, { slot: 'Ring 1', items: [RING_A] });
    expect(calls).toEqual(['add Ring 1 -> 100', 'add Ring 1 -> 101']);
    expect(res.content[0].text).toContain('remain in the item list');
  });
});
