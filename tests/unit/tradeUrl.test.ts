import { gunzipSync } from 'zlib';
import { buildTradeQuery, buildTradeSearchUrl, encodeTradeQuery, decodeTradeUrl, pickStatId, classifyMod, TRADE_IDS } from '../../src/services/tradeUrl.js';

function decode(payload: string): unknown {
  const buf = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return JSON.parse(gunzipSync(buf).toString('utf8'));
}

describe('tradeUrl - query shape the trade site accepts', () => {
  // Regression guard: a URL that decodes to a plausible-looking query still
  // fails on the site ("search no longer valid") if the shape is off. Every
  // stat filter must carry a `value` object (PoB's TradeQueryGenerator always
  // emits one), and type/category must be where the site expects them.
  const sample = buildTradeQuery({
    type: 'Viridian Jewel',
    category: 'jewel',
    rarity: 'nonunique',
    stats: [{ id: 'explicit.stat_3299347043' }],
  }) as any;

  it('gives every stat filter a value object', () => {
    const filters = sample.stats[0].filters;
    expect(filters.length).toBeGreaterThan(0);
    for (const filter of filters) {
      expect(filter).toHaveProperty('value');
      expect(typeof filter.value).toBe('object');
    }
  });

  it('keeps type, category and rarity in the documented places', () => {
    expect(sample.type).toBe('Viridian Jewel');
    expect(sample.filters.type_filters.filters.category).toEqual({ option: 'jewel' });
    expect(sample.filters.type_filters.filters.rarity).toEqual({ option: 'nonunique' });
  });

  it('omits min/max when the caller supplies no bounds', () => {
    expect(sample.stats[0].filters[0].value).toEqual({});
  });

  it('keeps explicit bounds when they are supplied', () => {
    const bounded = buildTradeQuery({
      category: 'jewel',
      rarity: 'nonunique',
      stats: [{ id: 'explicit.stat_3299347043', min: 14, max: 20 }],
    }) as any;
    expect(bounded.stats[0].filters[0].value).toEqual({ min: 14, max: 20 });
  });

  it('never emits a null or undefined anywhere in the payload', () => {
    const json = JSON.stringify(sample);
    expect(json).not.toContain('null');
    expect(json).not.toContain('undefined');
  });

  it('round-trips the golden payload', () => {
    const decoded = decode(encodeTradeQuery(sample));
    expect(decoded).toEqual(JSON.parse(JSON.stringify(sample)));
  });
});

describe('tradeUrl - derived searches must not be empty by construction', () => {
  // Regression guard for the real failure mode seen in play: a query carrying
  // an exact base AND every mod of the item matches nothing in the league, so
  // every generated link opened on an empty page.
  it('rare items default to base + category only', () => {
    const q = buildTradeQuery({
      type: 'Thorium Spirit Shield',
      category: 'armour.shield',
      rarity: 'nonunique',
      stats: [],
    }) as any;
    expect(q.type).toBe('Thorium Spirit Shield');
    expect(q.stats[0].filters).toEqual([]);
  });

  it('uniques keep their mod filters to pin the variant', () => {
    const q = buildTradeQuery({
      name: 'The Light of Meaning',
      category: 'jewel',
      rarity: 'unique',
      stats: [{ id: 'explicit.stat_1812306107' }],
    }) as any;
    expect(q.name).toBe('The Light of Meaning');
    expect(q.stats[0].filters.length).toBe(1);
    expect(q.stats[0].filters[0].id).toBe('explicit.stat_1812306107');
  });
});

describe('tradeUrl - status', () => {
  // The site's "Instant Buyout" is status.option = "securable" (verified by
  // decoding a URL the site itself produced with that dropdown selected).
  it('defaults to Instant Buyout', () => {
    const q = buildTradeQuery({ stats: [] }) as any;
    expect(q.status).toEqual({ option: 'securable' });
  });

  it('honours an explicit status', () => {
    expect((buildTradeQuery({ stats: [], status: 'any' }) as any).status).toEqual({ option: 'any' });
    expect((buildTradeQuery({ stats: [], status: 'online' }) as any).status).toEqual({ option: 'online' });
  });
});

describe('tradeUrl - decode/verify (guards against hand-copied payloads)', () => {
  const good = encodeTradeQuery(buildTradeQuery({
    type: 'Viridian Jewel', category: 'jewel', rarity: 'nonunique',
    stats: [{ id: 'explicit.stat_3299347043' }],
  }));

  it('accepts a valid payload and returns the query', () => {
    const d = decodeTradeUrl(good);
    expect(d.ok).toBe(true);
    if (d.ok) expect((d.query as any).type).toBe('Viridian Jewel');
  });

  it('rejects a payload with one character changed', () => {
    // Flip a character in the middle — exactly what transcription does.
    const mid = Math.floor(good.length / 2);
    const broken = good.slice(0, mid) + (good[mid] === 'A' ? 'B' : 'A') + good.slice(mid + 1);
    const d = decodeTradeUrl(broken);
    expect(d.ok).toBe(false);
  });

  it('rejects non-base64url characters', () => {
    const d = decodeTradeUrl(good.slice(0, 40) + ' ' + good.slice(41));
    expect(d.ok).toBe(false);
  });

  it('round-trips a full https URL, not just the payload', () => {
    const url = buildTradeSearchUrl('Covens', buildTradeQuery({ stats: [] }));
    const d = decodeTradeUrl(url);
    expect(d.ok).toBe(true);
  });
});

describe('tradeUrl - armour scope', () => {
  it('uses defence filters instead of a base for ordinary armour', () => {
    const q = buildTradeQuery({
      category: 'armour.gloves',
      rarity: 'nonunique',
      equipment: { ev: 1 },
      stats: [],
    }) as any;
    expect(q.type).toBeUndefined();
    expect(q.filters.armour_filters.filters).toEqual({ ev: { min: 1 } });
  });

  it('keeps a base type when the caller asks for one', () => {
    const q = buildTradeQuery({
      type: 'Opal Ring',
      category: 'accessory.ring',
      rarity: 'nonunique',
      stats: [],
    }) as any;
    expect(q.type).toBe('Opal Ring');
    expect(q.filters.armour_filters).toBeUndefined();
  });

  it('asks for both pools on a hybrid armour piece', () => {
    const q = buildTradeQuery({
      category: 'armour.helmet',
      rarity: 'unique',
      equipment: { ev: 1, es: 1 },
      stats: [],
    }) as any;
    expect(q.filters.armour_filters.filters).toEqual({ ev: { min: 1 }, es: { min: 1 } });
  });
});

describe('tradeUrl - stat id choice', () => {
  it('searches a fractured affix as its explicit twin', () => {
    expect(pickStatId(['fractured.stat_111', 'explicit.stat_111'], 'fractured')).toBe('explicit.stat_111');
  });

  it('keeps the domain when it is not fractured', () => {
    expect(pickStatId(['implicit.stat_5', 'explicit.stat_5'], 'implicit')).toBe('implicit.stat_5');
  });

  it('falls back to explicit, then to any candidate', () => {
    expect(pickStatId(['crafted.stat_9'], 'crafted')).toBe('crafted.stat_9');
    expect(pickStatId(['explicit.stat_2'], 'implicit')).toBe('explicit.stat_2');
    expect(pickStatId(['weird.stat_3'], 'implicit')).toBe('weird.stat_3');
  });
});

describe('tradeUrl - mod intent classification', () => {
  it('buckets resistances together', () => {
    expect(classifyMod('+40% to Fire Resistance')).toBe('ele_res');
    expect(classifyMod('+12% to all Elemental Resistances')).toBe('ele_res');
  });

  it('keeps chaos separate from elemental', () => {
    expect(classifyMod('+25% to Chaos Resistance')).toBe('chaos_res');
  });

  it('recognises attributes and life', () => {
    expect(classifyMod('+40 to Dexterity')).toBe('dex');
    expect(classifyMod('+31 to Intelligence')).toBe('int');
    expect(classifyMod('+90 to maximum Life')).toBe('life');
    expect(classifyMod('15% increased Cast Speed')).toBe('other');
  });

  it('builds an OR group only on request', () => {
    const and = buildTradeQuery({
      category: 'accessory.ring', rarity: 'nonunique',
      stats: [{ id: TRADE_IDS.totalEleRes, min: 45 }],
    }) as any;
    expect(and.stats.length).toBe(1);
    expect(and.stats[0].filters[0].id).toBe('pseudo.pseudo_total_elemental_resistance');

    const or = buildTradeQuery({
      category: 'accessory.ring', rarity: 'nonunique',
      stats: [],
      orStats: [{ id: TRADE_IDS.fireRes, min: 45 }, { id: TRADE_IDS.coldRes, min: 45 }],
    }) as any;
    expect(or.stats[1].type).toBe('or');
    expect(or.stats[1].filters.length).toBe(2);
  });
});

describe('tradeUrl', () => {
  it('encodes a bare query object, never a {query, sort} wrapper', () => {
    const query = buildTradeQuery({
      category: 'armour.shield',
      rarity: 'nonunique',
      stats: [{ id: 'pseudo.pseudo_total_life', min: 80 }],
    });

    const decoded = decode(encodeTradeQuery(query)) as Record<string, any>;

    // The trade site decodes the payload client-side and rejects a wrapped
    // payload ("Failed to load search state. The search is no longer valid.").
    expect(decoded.query).toBeUndefined();
    expect(decoded.sort).toBeUndefined();
    expect(decoded.status).toEqual({ option: 'securable' });
    expect(decoded.stats[0].filters[0]).toEqual({
      id: 'pseudo.pseudo_total_life',
      value: { min: 80 },
      disabled: false,
    });
    expect(decoded.filters.type_filters.filters.category).toEqual({ option: 'armour.shield' });
  });

  it('uses base64url without padding', () => {
    const encoded = encodeTradeQuery(buildTradeQuery({ stats: [] }));
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it('round-trips through gzip', () => {
    const query = buildTradeQuery({
      name: 'Soul Mantle',
      category: 'armour.chest',
      rarity: 'unique',
      minLinks: 6,
      stats: [{ id: 'implicit.stat_2551600084', min: 2 }],
    });
    const decoded = decode(encodeTradeQuery(query)) as Record<string, any>;
    expect(decoded.name).toBe('Soul Mantle');
    expect(decoded.filters.socket_filters.filters.links).toEqual({ min: 6 });
  });

  it('builds a league-scoped https URL', () => {
    const url = buildTradeSearchUrl('Covens', buildTradeQuery({ stats: [] }));
    expect(url.startsWith('https://www.pathofexile.com/trade/search/Covens/')).toBe(true);
    expect(url).not.toContain('{');
  });

  it('omits empty filter blocks instead of sending them', () => {
    const query = buildTradeQuery({ stats: [] }) as Record<string, any>;
    expect(query.filters).toBeUndefined();
    expect(query.stats[0].filters).toEqual([]);
  });

  it('decodes to exactly the JSON that was encoded', () => {
    const query = buildTradeQuery({ stats: [{ id: 'explicit.stat_1', min: 1 }] });
    const decoded = decode(encodeTradeQuery(query));
    expect(decoded).toEqual(JSON.parse(JSON.stringify(query)));
  });

  // Corruption is an option filter with string ids, and it is only sent when the
  // caller asks: an omitted filter shows clean and corrupted copies alike.
  it('sends a corruption filter only when asked', () => {
    const plain = buildTradeQuery({ stats: [] }) as Record<string, any>;
    expect(plain.filters?.misc_filters).toBeUndefined();

    const clean = buildTradeQuery({ stats: [], corrupted: false }) as Record<string, any>;
    expect(clean.filters.misc_filters.filters.corrupted).toEqual({ option: 'false' });

    const corrupted = buildTradeQuery({ stats: [], corrupted: true }) as Record<string, any>;
    expect(corrupted.filters.misc_filters.filters.corrupted).toEqual({ option: 'true' });
  });

  it('keeps corrupted in its own group beside defence and link filters', () => {
    const query = buildTradeQuery({
      category: 'armour.chest',
      rarity: 'unique',
      equipment: { es: 1 },
      minLinks: 6,
      corrupted: true,
      stats: [],
    }) as Record<string, any>;
    expect(query.filters.armour_filters.filters).toEqual({ es: { min: 1 } });
    expect(query.filters.socket_filters.filters).toEqual({ links: { min: 6 } });
    expect(query.filters.misc_filters.filters).toEqual({ corrupted: { option: 'true' } });
  });
});
