import { describe, it, expect } from '@jest/globals';
import zlib from 'node:zlib';
import { decodePobExportCode } from '../../src/handlers/importHandlers.js';

// Node ids, like a real tree: varied enough not to compress below the code-length threshold.
const NODES = Array.from({ length: 120 }, (_, i) => (i * 7919) % 65536).join(',');
const XML =
  '<?xml version="1.0" encoding="UTF-8"?>\n<PathOfBuilding>\n' +
  '<Build level="97" className="Witch" ascendClassName="Necromancer"/>\n' +
  `<Spec nodes="${NODES}"/>\n</PathOfBuilding>`;

/** The encoding PoB's Import/Export tab produces: URL-safe base64 of zlib deflate. */
const encode = (xml: string, raw = false): string =>
  (raw ? zlib.deflateRawSync(xml) : zlib.deflateSync(xml))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

describe('decodePobExportCode', () => {
  it('round-trips a zlib export code', () => {
    expect(decodePobExportCode(encode(XML))).toBe(XML);
  });

  it('accepts raw-deflate codes and surrounding whitespace', () => {
    expect(decodePobExportCode(`  ${encode(XML, true)}\n`)).toBe(XML);
  });

  it('returns null for URLs and short pobb.in IDs so they fall through', () => {
    expect(decodePobExportCode('https://pobb.in/kpRns1vROvV3')).toBeNull();
    expect(decodePobExportCode('kpRns1vROvV3')).toBeNull();
    expect(decodePobExportCode('https://poedb.tw/us/PathOfBuilding?id=E22R8MtObaQv')).toBeNull();
  });

  it('throws on a code-shaped string that does not decode', () => {
    expect(() => decodePobExportCode('A'.repeat(300))).toThrow(/could not be decoded/);
  });

  it('throws when the decoded payload is not PoB XML', () => {
    const notPob = '<html>' + Array.from({ length: 200 }, (_, i) => (i * 104729) % 99991).join(' ') + '</html>';
    expect(() => decodePobExportCode(encode(notPob))).toThrow(/not Path of Building XML/);
  });
});
