import { gzipSync, gunzipSync } from 'zlib';

/**
 * Build trade-site search URLs the way Path of Building does it.
 *
 * Reference: `PathOfBuilding/src/Classes/TradeQuery.lua`
 *   `url = url .. "/" .. tradeHelpers.B64GzipEncode(dkjson.encode(query))`
 * with the comment on the next line: "Trade URLs contain only the query; the
 * API also needs the sort order."
 *
 * The payload is therefore **gzip(query) -> base64url**, and the query is the
 * bare query object. Wrapping it as `{ query, sort }` produces a URL that the
 * trade site refuses to load ("Failed to load search state. The search is no
 * longer valid.") — that mistake is easy to make and hard to spot, because the
 * encoded string looks perfectly plausible.
 *
 * Generating a URL this way costs zero API requests: the trade site decodes the
 * payload client-side. Prefer it over `search_trade_items` whenever the caller
 * only needs a link (e.g. handing "buy similar" links to the user).
 */
export function encodeTradeQuery(query: unknown): string {
  const json = JSON.stringify(query);
  const compressed = gzipSync(Buffer.from(json, 'utf8'), { level: 9 });
  return compressed
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function buildTradeSearchUrl(
  league: string,
  query: unknown,
  host: string = 'https://www.pathofexile.com'
): string {
  return `${host}/trade/search/${encodeURIComponent(league)}/${encodeTradeQuery(query)}`;
}

/**
 * Normalise a mod line so it can be compared with a trade stat's text: every
 * numeric run becomes '#', the same placeholder the trade site uses.
 *   "+45% to Fire Resistance" -> "+#% to fire resistance"
 */
export function normalizeModText(text: string): string {
  return text
    .toLowerCase()
    // Replace the digits only: the leading '+' must survive, because trade stat
    // texts keep it ("+# to maximum Life") while the number itself becomes '#'.
    // Swallowing the sign makes every "+N ..." line unmatchable.
    .replace(/\d+(?:\.\d+)?/g, '#')
    // Item text and trade stat text disagree on punctuation ("grant: +4%" vs
    // "grant +#%"), so strip every punctuation mark except the ones that carry
    // meaning inside a mod: '%', '+' and the '#' placeholder.
    .replace(/[^a-z#%+\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** First numeric value on a mod line, used to derive a `min` filter. */
export function firstModValue(text: string): number | null {
  const match = text.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

/** Map PoB's parsed item type (or a slot name) to a trade category option. */
export function tradeCategoryFor(typeOrSlot: string): string | undefined {
  const t = typeOrSlot.toLowerCase();
  if (t.includes('jewel')) return 'jewel';
  if (t.includes('shield')) return 'armour.shield';
  if (t.includes('glove')) return 'armour.gloves';
  if (t.includes('boot')) return 'armour.boots';
  if (t.includes('helmet') || t.includes('helm')) return 'armour.helmet';
  if (t.includes('body') || t.includes('chest')) return 'armour.chest';
  if (t.includes('ring')) return 'accessory.ring';
  if (t.includes('amulet')) return 'accessory.amulet';
  if (t.includes('belt')) return 'accessory.belt';
  if (t.includes('wand')) return 'weapon.wand';
  if (t.includes('staff')) return 'weapon.staff';
  if (t.includes('dagger')) return 'weapon.dagger';
  if (t.includes('sceptre') || t.includes('scepter')) return 'weapon.sceptre';
  if (t.includes('claw')) return 'weapon.claw';
  if (t.includes('sword')) return 'weapon.one';
  if (t.includes('axe')) return 'weapon.one';
  if (t.includes('mace')) return 'weapon.one';
  if (t.includes('quiver')) return 'armour.quiver';
  return undefined;
}

export interface DecodedTradeUrlOk {
  ok: true;
  /** Decoded query object, exactly what the trade site would load. */
  query: any;
  payloadLength: number;
}
export interface DecodedTradeUrlErr {
  ok: false;
  error: string;
  payloadLength: number;
}
export type DecodedTradeUrl = DecodedTradeUrlOk | DecodedTradeUrlErr;

/**
 * Decode and validate a trade link (or a bare payload) without any network
 * call. Anything that is not valid base64url -> gzip -> JSON is rejected here,
 * which is what catches the corruption an eye cannot see: one changed
 * character in base64url breaks the gzip CRC and the site answers "the search
 * is no longer valid".
 */
export function decodeTradeUrl(input: string): DecodedTradeUrl {
  const raw = String(input ?? '').trim();
  const payload = raw.includes('/trade/search/') ? raw.split('?')[0].split('/').pop() ?? '' : raw;
  const payloadLength = payload.length;

  if (!/^[A-Za-z0-9_-]+$/.test(payload)) {
    return { ok: false, error: 'payload contains characters outside base64url (corrupted copy)', payloadLength };
  }

  let json: string;
  try {
    const buf = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    json = gunzipSync(buf).toString('utf8');
  } catch (e) {
    return {
      ok: false,
      error: `gzip decode failed (${(e as Error).message}) — the payload is almost certainly a corrupted copy`,
      payloadLength,
    };
  }

  try {
    return { ok: true, query: JSON.parse(json), payloadLength };
  } catch (e) {
    return { ok: false, error: `decoded bytes are not JSON (${(e as Error).message})`, payloadLength };
  }
}

/**
 * Round-trip check for a generated URL: decode it and compare with the query it
 * was built from. A mismatch means the string was mangled somewhere between
 * generation and delivery.
 */
export function verifyTradeUrl(url: string, expected: unknown): { ok: boolean; error?: string } {
  const decoded = decodeTradeUrl(url);
  if (!decoded.ok) return { ok: false, error: decoded.error };
  const a = JSON.stringify(decoded.query);
  const b = JSON.stringify(expected);
  return a === b ? { ok: true } : { ok: false, error: 'decoded payload does not match the query it was built from' };
}

/**
 * Choose which trade stat id to use for a mod line.
 *
 * A fractured affix searches as its ordinary (explicit) twin: the fractured
 * flag describes how the item was made, not what the buyer needs, and
 * `fractured.stat_*` narrows the result to fractured items only.
 */
export function pickStatId(candidates: string[], domain: string): string | undefined {
  const wanted = domain === 'fractured' ? 'explicit' : domain;
  return (
    candidates.find((c) => c.startsWith(`${wanted}.`)) ??
    candidates.find((c) => c.startsWith('explicit.')) ??
    candidates[0]
  );
}

/** What a slot has to supply, taken from the requirement sheet (never guessed). */
export interface SlotNeeds {
  /** Total elemental resistance this slot must contribute. */
  ele_res?: number;
  /** Chaos resistance this slot must contribute. */
  chaos_res?: number;
  /** Flat life floor for the slot. */
  life?: number;
  /** Attribute floors the slot must clear. */
  dex?: number;
  str?: number;
  int?: number;
}

export type ModIntent = 'ele_res' | 'chaos_res' | 'life' | 'dex' | 'str' | 'int' | 'other';

/**
 * Bucket a mod line by what it is FOR. The bucket decides the filter strategy:
 * resistances collapse into a pseudo total (any combination counts), attributes
 * keep a real minimum (dex does not substitute for int), everything else is
 * matched by presence.
 */
export function classifyMod(line: string): ModIntent {
  const l = line.toLowerCase();
  if (/to all elemental resistances/.test(l)) return 'ele_res';
  if (/\bto (fire|cold|lightning) resistance\b/.test(l)) return 'ele_res';
  if (/to chaos resistance/.test(l)) return 'chaos_res';
  if (/to maximum life/.test(l)) return 'life';
  if (/to dexterity/.test(l)) return 'dex';
  if (/to strength/.test(l)) return 'str';
  if (/to intelligence/.test(l)) return 'int';
  return 'other';
}

/** Trade stat ids used by the strategies above. */
export const TRADE_IDS = {
  totalEleRes: 'pseudo.pseudo_total_elemental_resistance',
  totalLife: 'pseudo.pseudo_total_life',
  fireRes: 'explicit.stat_3372524247',
  coldRes: 'explicit.stat_4220027924',
  lightRes: 'explicit.stat_1671376347',
} as const;

export interface TradeUrlStatFilter {
  /** Trade stat id, e.g. `pseudo.pseudo_total_life`, `explicit.stat_2974417149`. */
  id: string;
  min?: number;
  max?: number;
  disabled?: boolean;
}


export interface TradeUrlSpec {
  /** Unique item name, e.g. `Mageblood`. */
  name?: string;
  /** Base type, e.g. `Titanium Spirit Shield`. */
  type?: string;
  /** Trade category, e.g. `armour.shield`, `accessory.ring`, `jewel`. */
  category?: string;
  rarity?: 'normal' | 'magic' | 'rare' | 'unique' | 'nonunique' | 'any';
  /** Minimum linked sockets (6 for a six-link). */
  minLinks?: number;
  stats?: TradeUrlStatFilter[];
  /**
   * Extra stat group of type `or` — "any one of these", e.g. fire OR cold OR
   * lightning resistance at the same threshold. Mirrors the trade site's
   * "Add stat group" control.
   */
  orStats?: TradeUrlStatFilter[];
  /**
   * Defence filters for ordinary armour. Preferred over a base-type filter for
   * ES/EV/AR pieces: pinning the base throws away every equally good item of a
   * neighbouring base, while `es: 1` only requires "has an energy-shield pool".
   */
  equipment?: { ar?: number; ev?: number; es?: number; ward?: number };
  /**
   * Seller status. `securable` is the site's "Instant Buyout" and is the
   * default: a listing you can actually click-buy, not one waiting on a reply.
   */
  status?: TradeStatusOption;
  /**
   * Corruption filter, `misc_filters.corrupted`. **Unset by default and that is
   * the intended state**: with no filter, the search returns clean and
   * corrupted copies alike, so nothing is hidden from the buyer. Set it only on
   * an explicit request (`true` = only corrupted, `false` = only clean). It is
   * never inferred from the item: a slot that needs a corruption implicit is
   * handled by requiring that mod, not by guessing the corruption state.
   */
  corrupted?: boolean;
  /** @deprecated use `status`; false maps to `any`. */
  onlineOnly?: boolean;
}

/** `securable` = Instant Buyout, `online` = In Person (Online), `any` = all. */
export type TradeStatusOption = 'securable' | 'online' | 'any';

/**
 * Minimal query object for the trade site. Deliberately small: every field that
 * is not set is omitted, which keeps the encoded URL short.
 */
export function buildTradeQuery(spec: TradeUrlSpec): Record<string, unknown> {
  // Instant Buyout by default: the user can click and buy without whispering,
  // so a link that only shows "In Person (Online)" listings is half useless.
  // The site's own canonical encoding for that is status.option = "securable".
  const status: TradeStatusOption =
    spec.status ?? (spec.onlineOnly === false ? 'any' : 'securable');
  const toFilter = (stat: TradeUrlStatFilter) => {
    const value: Record<string, number> = {};
    if (typeof stat.min === 'number') value.min = stat.min;
    if (typeof stat.max === 'number') value.max = stat.max;
    // The trade site rejects a stat filter without `value` — even an empty one.
    return { id: stat.id, value, disabled: stat.disabled ?? false };
  };

  // The trade site expects the `and` group first; an `or` group follows.
  const statGroups: Array<Record<string, unknown>> = [
    { type: 'and', filters: (spec.stats ?? []).map(toFilter) },
  ];
  if (spec.orStats && spec.orStats.length > 0) {
    statGroups.push({ type: 'or', filters: spec.orStats.map(toFilter) });
  }
  const query: Record<string, unknown> = {
    status: { option: status },
    stats: statGroups,
  };

  if (spec.name) query.name = spec.name;
  if (spec.type) query.type = spec.type;

  const filters: Record<string, unknown> = {};
  const typeFilters: Record<string, unknown> = {};
  if (spec.category) typeFilters.category = { option: spec.category };
  if (spec.rarity && spec.rarity !== 'any') typeFilters.rarity = { option: spec.rarity };
  if (Object.keys(typeFilters).length > 0) filters.type_filters = { filters: typeFilters };
  if (spec.equipment) {
    const equipmentFilters: Record<string, unknown> = {};
    if (typeof spec.equipment.ar === 'number') equipmentFilters.ar = { min: spec.equipment.ar };
    if (typeof spec.equipment.ev === 'number') equipmentFilters.ev = { min: spec.equipment.ev };
    if (typeof spec.equipment.es === 'number') equipmentFilters.es = { min: spec.equipment.es };
    if (typeof spec.equipment.ward === 'number') equipmentFilters.ward = { min: spec.equipment.ward };
    if (Object.keys(equipmentFilters).length > 0) filters.armour_filters = { filters: equipmentFilters };
  }
  if (spec.minLinks) filters.socket_filters = { filters: { links: { min: spec.minLinks } } };
  // Corruption is an option filter with string ids ("true"/"false"), not a
  // boolean — that is the shape the site's own payloads use.
  const miscFilters: Record<string, unknown> = {};
  if (typeof spec.corrupted === 'boolean') {
    miscFilters.corrupted = { option: spec.corrupted ? 'true' : 'false' };
  }
  if (Object.keys(miscFilters).length > 0) filters.misc_filters = { filters: miscFilters };
  if (Object.keys(filters).length > 0) query.filters = filters;

  return query;
}
