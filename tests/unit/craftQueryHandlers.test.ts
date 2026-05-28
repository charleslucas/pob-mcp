import { describe, it, expect } from '@jest/globals';
import { existsSync } from 'fs';
import { resolve } from 'path';

import {
  handleSearchMasterCrafts,
  handleGetEssenceDetail,
} from '../../src/handlers/craftQueryHandlers';

const pobDir = process.env.POB_DIRECTORY ?? resolve(process.cwd(), '..', 'PathOfBuilding');
const hasData =
  existsSync(resolve(pobDir, 'src', 'Data', 'ModMaster.lua')) &&
  existsSync(resolve(pobDir, 'src', 'Data', 'Essence.lua'));

const describeIfPob = hasData ? describe : describe.skip;

function getText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join('\n');
}

describeIfPob('handleSearchMasterCrafts', () => {
  it('rejects empty filters', async () => {
    const r = await handleSearchMasterCrafts({});
    expect(r.isError).toBe(true);
  });

  it('returns bench crafts for a stat + item type', async () => {
    const r = await handleSearchMasterCrafts({ stat_contains: 'Movement Speed', item_type: 'Boots' });
    const text = getText(r);
    expect(text).toMatch(/Movement Speed/);
    expect(text).toMatch(/bench/i);
  });

  it('returns JSON when requested', async () => {
    const r = await handleSearchMasterCrafts({ item_type: 'Ring', raw_json: true });
    const parsed = JSON.parse(getText(r));
    expect(parsed.source).toMatch(/ModMaster\.lua/);
    expect(Array.isArray(parsed.results)).toBe(true);
  });
});

describeIfPob('handleGetEssenceDetail', () => {
  it('rejects when neither essence_name nor stat_contains given', async () => {
    const r = await handleGetEssenceDetail({});
    expect(r.isError).toBe(true);
  });

  it('shows what an essence guarantees per item type', async () => {
    const r = await handleGetEssenceDetail({ essence_name: 'Deafening Essence of Greed' });
    const text = getText(r);
    expect(text).toMatch(/Deafening Essence of Greed/);
    expect(text).toMatch(/Body Armour/);
    expect(text).toMatch(/maximum Life/i);
  });

  it('narrows to a single item type', async () => {
    const r = await handleGetEssenceDetail({
      essence_name: 'Deafening Essence of Greed',
      item_type: 'Body Armour',
      raw_json: true,
    });
    const parsed = JSON.parse(getText(r));
    expect(parsed.guarantees.length).toBe(1);
    expect(parsed.guarantees[0].itemType).toBe('Body Armour');
  });

  it('suggests on essence-name miss', async () => {
    const r = await handleGetEssenceDetail({ essence_name: 'Essence of Greed' });
    const text = getText(r);
    expect(text).toMatch(/not found|Greed/);
  });

  it('lists essences providing a stat', async () => {
    const r = await handleGetEssenceDetail({ stat_contains: 'Fire Resistance' });
    const text = getText(r);
    expect(text).toMatch(/Essences providing/);
    expect(text).toMatch(/tier/);
  });
});
