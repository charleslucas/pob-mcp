import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Redirect the patches service to a temp dir BEFORE importing it.
const TMP = mkdtempSync(join(tmpdir(), 'pob-mcp-patches-test-'));
process.env.SKILLTREE_DIRECTORY = TMP;

import {
  getPatches,
  getPatch,
  upsertPatch,
  removePatch,
  listPatchesSummary,
  getPatchesFilePath,
} from '../../src/services/skilltreePatchesService';

const PATCH_FILE = join(TMP, 'data_patches.json');

function resetPatchFile(contents: object = {}) {
  writeFileSync(PATCH_FILE, JSON.stringify(contents), 'utf-8');
}

afterAll(() => {
  // Clean up the temp directory
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
});

describe('skilltreePatchesService — path resolution', () => {
  it('resolves to the SKILLTREE_DIRECTORY env override', () => {
    expect(getPatchesFilePath()).toBe(PATCH_FILE);
  });
});

describe('skilltreePatchesService — read', () => {
  beforeEach(() => resetPatchFile({}));

  it('returns empty object when file does not exist', () => {
    if (existsSync(PATCH_FILE)) rmSync(PATCH_FILE);
    expect(getPatches()).toEqual({});
  });

  it('returns the parsed file contents when present', () => {
    resetPatchFile({
      '11730': {
        stats_add: ['test stat'],
        verified_from: 'in-game tooltip',
        verified_date: '2026-01-01',
        verified_by: 'TestUser#1234',
      },
    });
    const patches = getPatches();
    expect(patches['11730']).toBeDefined();
    expect(patches['11730'].verified_by).toBe('TestUser#1234');
  });

  it('returns null for getPatch on missing node', () => {
    resetPatchFile({});
    expect(getPatch('99999')).toBeNull();
  });
});

describe('skilltreePatchesService — upsertPatch', () => {
  beforeEach(() => resetPatchFile({}));

  it('creates a new entry with todays date and the supplied metadata', () => {
    const result = upsertPatch({
      nodeId: '11730',
      operation: 'stats_add',
      value: ['+1 test stat'],
      verified_from: 'in-game tooltip',
      verified_by: 'Memophage#4428',
      note: 'test note',
    });
    expect(result.action).toBe('created');
    expect(result.previous).toBeNull();
    expect(result.entry.stats_add).toEqual(['+1 test stat']);
    expect(result.entry.verified_by).toBe('Memophage#4428');
    expect(result.entry.note).toBe('test note');
    // verified_date should be ISO YYYY-MM-DD
    expect(result.entry.verified_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('persists to disk in pretty JSON form', () => {
    upsertPatch({
      nodeId: '11730',
      operation: 'stats_add',
      value: ['+1 test stat'],
      verified_from: 'in-game tooltip',
      verified_by: 'Tester',
    });
    const raw = readFileSync(PATCH_FILE, 'utf-8');
    expect(raw).toContain('\n  "11730"'); // pretty-printed
    const parsed = JSON.parse(raw);
    expect(parsed['11730']).toBeDefined();
  });

  it('updates an existing entry and returns the previous one', () => {
    upsertPatch({
      nodeId: '11730',
      operation: 'stats_add',
      value: ['+1 first version'],
      verified_from: 'wiki',
      verified_by: 'OldUser',
    });
    const second = upsertPatch({
      nodeId: '11730',
      operation: 'stats_replace',
      value: ['+1 second version', '+2 another'],
      verified_from: 'in-game tooltip',
      verified_by: 'NewUser',
    });
    expect(second.action).toBe('updated');
    expect(second.previous).not.toBeNull();
    expect(second.previous?.verified_by).toBe('OldUser');
    expect(second.entry.stats_replace).toEqual(['+1 second version', '+2 another']);
    // The new entry should be a fresh entry (no leftover stats_add)
    expect(second.entry.stats_add).toBeUndefined();
  });

  it('rejects stats_add with non-array value', () => {
    expect(() =>
      upsertPatch({
        nodeId: '11730',
        operation: 'stats_add',
        value: 'not an array',
        verified_from: 'in-game tooltip',
        verified_by: 'Tester',
      })
    ).toThrow(/stats_add requires/);
  });

  it('rejects name_replace with non-string value', () => {
    expect(() =>
      upsertPatch({
        nodeId: '11730',
        operation: 'name_replace',
        value: ['not a string'],
        verified_from: 'in-game tooltip',
        verified_by: 'Tester',
      })
    ).toThrow(/name_replace requires/);
  });

  it('handles flags_set with an object value', () => {
    const result = upsertPatch({
      nodeId: '11730',
      operation: 'flags_set',
      value: { isNotable: true, isKeystone: false },
      verified_from: 'in-game tooltip',
      verified_by: 'Tester',
    });
    expect(result.entry.flags_set).toEqual({ isNotable: true, isKeystone: false });
  });
});

describe('skilltreePatchesService — removePatch', () => {
  beforeEach(() => resetPatchFile({}));

  it('returns not_found when the node has no patch', () => {
    const r = removePatch('11730');
    expect(r.action).toBe('not_found');
    expect(r.previous).toBeNull();
  });

  it('removes an existing patch and returns the previous entry', () => {
    upsertPatch({
      nodeId: '11730',
      operation: 'stats_add',
      value: ['+1 test'],
      verified_from: 'wiki',
      verified_by: 'Tester',
    });
    const r = removePatch('11730');
    expect(r.action).toBe('removed');
    expect(r.previous?.verified_by).toBe('Tester');
    expect(getPatch('11730')).toBeNull();
  });
});

describe('skilltreePatchesService — listPatchesSummary', () => {
  beforeEach(() => resetPatchFile({}));

  it('returns empty when no patches', () => {
    expect(listPatchesSummary()).toEqual([]);
  });

  it('returns summaries with operation lists', () => {
    upsertPatch({
      nodeId: '11730',
      operation: 'stats_add',
      value: ['+1 a'],
      verified_from: 'in-game tooltip',
      verified_by: 'Tester',
    });
    upsertPatch({
      nodeId: '12345',
      operation: 'name_replace',
      value: 'NewName',
      verified_from: 'wiki',
      verified_by: 'Tester2',
    });
    const list = listPatchesSummary();
    expect(list).toHaveLength(2);
    const e1 = list.find((s) => s.nodeId === '11730');
    const e2 = list.find((s) => s.nodeId === '12345');
    expect(e1?.operations).toEqual(['stats_add']);
    expect(e2?.operations).toEqual(['name_replace']);
  });

  it('sorts by age descending (oldest first)', () => {
    // Manually craft old patches to test sorting
    resetPatchFile({
      'new_one': {
        stats_add: ['+1'],
        verified_from: 'in-game tooltip',
        verified_date: '2026-05-01',
        verified_by: 'Tester',
      },
      'old_one': {
        stats_add: ['+1'],
        verified_from: 'in-game tooltip',
        verified_date: '2025-01-01',
        verified_by: 'Tester',
      },
    });
    const list = listPatchesSummary();
    expect(list[0].nodeId).toBe('old_one'); // older first
    expect(list[1].nodeId).toBe('new_one');
    expect(list[0].age_days).toBeGreaterThan(list[1].age_days);
  });
});
