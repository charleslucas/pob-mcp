import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { atomicWriteFile } from '../../src/utils/atomicWrite.js';

describe('atomicWriteFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-write-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates a new file', async () => {
    const target = path.join(dir, 'build.xml');
    await atomicWriteFile(target, '<PathOfBuilding/>');
    expect(await fs.readFile(target, 'utf8')).toBe('<PathOfBuilding/>');
  });

  it('replaces an existing file and leaves no temp files behind', async () => {
    const target = path.join(dir, 'build.xml');
    await fs.writeFile(target, 'old');
    await atomicWriteFile(target, 'new');
    expect(await fs.readFile(target, 'utf8')).toBe('new');
    expect(await fs.readdir(dir)).toEqual(['build.xml']);
  });

  it('writes Buffers byte-exact (CR CR LF survives)', async () => {
    const target = path.join(dir, 'notes.xml');
    const bytes = Buffer.from('a\r\r\nb', 'utf8');
    await atomicWriteFile(target, bytes);
    expect(Buffer.compare(await fs.readFile(target), bytes)).toBe(0);
  });

  it('keeps the old file intact when the write fails', async () => {
    const target = path.join(dir, 'missing-dir', 'build.xml');
    await expect(atomicWriteFile(target, 'x')).rejects.toThrow();
    const real = path.join(dir, 'build.xml');
    await fs.writeFile(real, 'old');
    // A directory where the file should be makes rename fail after the temp write.
    const blocked = path.join(dir, 'blocked');
    await fs.mkdir(blocked);
    await fs.writeFile(path.join(blocked, 'keep'), 'k');
    await expect(atomicWriteFile(blocked, 'new')).rejects.toThrow();
    expect(await fs.readFile(real, 'utf8')).toBe('old');
    expect((await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
