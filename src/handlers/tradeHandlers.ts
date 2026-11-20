import { wrapHandler } from '../utils/errorHandling.js';
import { TradeApiClient } from '../services/tradeClient.js';
import { TradeQueryBuilder } from '../services/tradeQueryBuilder.js';
import { StatMapper } from '../services/statMapper.js';
import { ItemRecommendationEngine, UpgradeContext } from '../services/itemRecommendationEngine.js';
import { ItemListing, SearchOptions, ItemRecommendation, ResistanceRequirements, BudgetConstraints, TradeQuery } from '../types/tradeTypes.js';
import { CostBenefitAnalyzer } from '../services/costBenefitAnalyzer.js';
import { PoeNinjaClient } from '../services/poeNinjaClient.js';
import type { AnyLuaClient } from '../pobLuaBridge.js';
import { resolveLeague } from '../services/leagueResolver.js';
import { buildTradeQuery, buildTradeSearchUrl, normalizeModText, firstModValue, tradeCategoryFor, pickStatId, classifyMod, TRADE_IDS, TradeUrlSpec, SlotNeeds } from '../services/tradeUrl.js';
import { decodeTradeUrl, type DecodedTradeUrlErr } from '../services/tradeUrl.js';
import fs from 'fs/promises';
import path from 'path';

interface TradeContext {
  tradeClient: TradeApiClient;
  statMapper?: StatMapper;
  recommendationEngine?: ItemRecommendationEngine;
  ninjaClient?: PoeNinjaClient;
}

interface WeightedTradeContext extends TradeContext {
  getLuaClient: () => AnyLuaClient | null;
  ensureLuaClient: () => Promise<void>;
}

// ========================================
// Trade Site URL Helpers
// ========================================

function getTradeSearchUrl(league: string, searchId: string): string {
  return `https://www.pathofexile.com/trade/search/${encodeURIComponent(league)}/${searchId}`;
}

function getTradeItemUrl(league: string, searchId: string, itemId: string): string {
  // Individual items can be highlighted in the search results
  return `https://www.pathofexile.com/trade/search/${encodeURIComponent(league)}/${searchId}#${itemId}`;
}

// The MCP schema exposes `mods` with `stat_id` while the handler internally
// uses `stats` with `id` (the PoE trade API shape). Accept both and normalize
// so neither convention silently drops filters.
export function toStatFilters(
  stats?: Array<{ id: string; min?: number; max?: number }>,
  mods?: Array<{ stat_id: string; min?: number; max?: number }>
): Array<{ id: string; min?: number; max?: number }> {
  if (stats && stats.length > 0) return stats;
  if (mods && mods.length > 0) {
    return mods.map((mod) => ({ id: mod.stat_id, min: mod.min, max: mod.max }));
  }
  return [];
}

/**
 * Search the Path of Exile trade site for items
 */
export async function handleSearchTradeItems(
  context: TradeContext,
  args: {
    league: string;
    item_name?: string;
    item_type?: string;
    min_price?: number;
    max_price?: number;
    price_currency?: string;
    online_only?: boolean;
    online_status?: 'available' | 'online' | 'onlineleague' | 'securable' | 'any';
    rarity?: 'normal' | 'magic' | 'rare' | 'unique' | 'any';
    item_rarity?: 'normal' | 'magic' | 'rare' | 'unique' | 'any';
    min_links?: number;
    stats?: Array<{ id: string; min?: number; max?: number }>;
    mods?: Array<{ stat_id: string; min?: number; max?: number }>;
    sort?: 'price_asc' | 'price_desc';
    limit?: number;
  }
): Promise<{
  content: Array<{
    type: string;
    text: string;
  }>;
}> {
  return wrapHandler('search trade items', async () => {
    const {
      league,
      item_name,
      item_type,
      min_price,
      max_price,
      price_currency = 'chaos',
      online_only = true,
      online_status,
      rarity,
      item_rarity,
      min_links,
      stats,
      mods,
      sort = 'price_asc',
      limit = 5,
    } = args;

    // Build the query
    const builder = new TradeQueryBuilder();

    if (item_name) {
      builder.withName(item_name);
    }

    if (item_type) {
      builder.withType(item_type);
    }

    const effectiveRarity = rarity ?? item_rarity;
    if (effectiveRarity) {
      builder.withRarity(effectiveRarity);
    }

    if (min_links) {
      builder.withLinks(min_links);
    }

    const statFilters = toStatFilters(stats, mods);
    if (statFilters.length > 0) {
      builder.withStats(statFilters);
    }

    builder.applyOptions({
      league,
      onlineOnly: online_only,
      onlineStatus: online_status,
      minPrice: min_price,
      maxPrice: max_price,
      priceCurrency: price_currency,
      sort,
      limit,
    });

    const query = builder.build();

    // Execute search — one API call to get a searchId and total count.
    // We deliberately do NOT fetch listings (no fetchItems call) to follow the
    // ExileExchange pattern: return a URL for the user to open rather than
    // programmatically pulling listing data. See legal_considerations.md §TOS.
    const searchResult = await context.tradeClient.searchItems(league, query);

    if (!searchResult.result || searchResult.result.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No items found matching your search criteria in ${league} league.`,
          },
        ],
      };
    }

    const url = getTradeSearchUrl(league, searchResult.id);
    const output =
      `=== Trade Search (${league}) ===\n` +
      `Total listings: ${searchResult.total}\n` +
      `\n🔗 ${url}\n` +
      `\nOpen the link above to browse results on the trade site.\n` +
      `Note: This product is not affiliated with or endorsed by Grinding Gear Games.`;

    return {
      content: [{ type: 'text', text: output }],
    };
  });
}

/**
 * Generate a trade-site search URL WITHOUT calling the trade API.
 *
 * The URL is produced exactly like Path of Building's "Buy similar" button
 * (see services/tradeUrl.ts). Use this whenever only a link is needed — it
 * costs no API request, so it is safe to call for every gear slot, and it is
 * the correct tool before reaching for `search_trade_items`.
 */
export async function handleGenerateTradeUrl(
  args: {
    league: string;
    query?: Record<string, unknown>;
    item_name?: string;
    item_type?: string;
    category?: string;
    rarity?: 'normal' | 'magic' | 'rare' | 'unique' | 'nonunique' | 'any';
    min_links?: number;
    stats?: Array<{ id: string; min?: number; max?: number; disabled?: boolean }>;
    online_only?: boolean;
    /** Read this equipped slot and derive the filters from the item's own mods. */
    item_slot?: string;
    /** Same, but from raw clipboard text instead of an equipped slot. */
    item_text?: string;
    /** Lower bound for derived numeric filters, as a fraction of the item's roll. */
    min_roll_pct?: number;
    /** What this slot must supply, from the requirement sheet. */
    needs?: SlotNeeds;
    /** Emit an OR group (fire/cold/lightning) instead of a pseudo total. */
    or_mode?: boolean;
    /**
     * Whether to add the item's own mods as stat filters. Defaults to true for
     * uniques (they pin the variant) and false for rares (an exact base plus
     * every mod matches nothing in practice — the caller fills in the stats).
     */
    include_mods?: boolean;
    /** Also constrain the base type when deriving filters from a rare item. */
    same_base?: boolean;
    /**
     * Corruption filter (`misc_filters.corrupted`). **Omitted by default** — no
     * filter is sent, so clean and corrupted listings both appear. Pass `true`
     * or `false` only when the caller explicitly wants to restrict the search;
     * never infer it from the item.
     */
    corrupted?: boolean;
    /**
     * Get a server-issued search id (one trade API request) instead of a
     * self-contained payload. Default false: the link carries gzip+base64url of
     * the bare query, as PoB's own "Buy similar" builds it (TradeQuery.lua), and
     * costs no request. "Failed to load search state" comes from wrapping the
     * payload as { query, sort } — see services/tradeUrl.ts.
     */
    use_api?: boolean;
  },
  deps?: {
    statMapper?: StatMapper;
    getLuaClient?: () => AnyLuaClient | null;
    ensureLuaClient?: () => Promise<void>;
    tradeClient?: TradeApiClient;
  }
): Promise<{
  content: Array<{
    type: string;
    text: string;
  }>;
}> {
  return wrapHandler('generate trade url', async () => {
    if (!args.league) {
      throw new Error('Missing required argument: league');
    }

    const spec: TradeUrlSpec = {
      name: args.item_name,
      type: args.item_type,
      category: args.category,
      rarity: args.rarity,
      minLinks: args.min_links,
      stats: args.stats ? [...args.stats] : [],
      onlineOnly: args.online_only,
      // No corruption filter unless the caller asks for one: an omitted filter
      // shows clean and corrupted listings alike, which is the safe default.
      // Guessing "clean only" hides cheap corrupted copies the buyer may want.
      corrupted: args.corrupted,
    };

    const derivedFrom: string[] = [];

    // Deriving filters from an item is the whole point: an item's own mods are
    // what makes two variants of the same unique distinguishable (The Light of
    // Meaning grants chaos res OR elemental res, Ashes quality ranges, The Gull
    // has a Foulborn twin, ...). Name-only filters silently match any variant.
    if (args.item_slot || args.item_text) {
      await deps?.ensureLuaClient?.();
      const lua = deps?.getLuaClient?.();
      if (!lua) throw new Error('Lua bridge not active — needed to read the equipped item.');

      let raw = args.item_text ?? '';
      if (args.item_slot) {
        const items = await lua.getItems();
        const wanted = args.item_slot.trim().toLowerCase();
        const entry = (items as any[]).find((it: any) => String(it.slot ?? '').trim().toLowerCase() === wanted);
        if (!entry || !entry.id || !entry.raw) {
          throw new Error(`Slot "${args.item_slot}" is empty — equip the item first, or pass item_text.`);
        }
        raw = entry.raw;
      }

      const parsed = await lua.parseItem(raw);
      const unique = String(parsed.rarity ?? '').toUpperCase() === 'UNIQUE';

      if (unique) {
        // PoB returns "<unique name>, <base type>" in `name`; the trade site
        // matches on the bare unique name and rejects the combined string.
        // Foulborn variants carry the prefix in their display name but the site
        // indexes them under the base unique ("Kikazaru", not "Foulborn
        // Kikazaru") — the variant is pinned by the mod filters instead.
        const bareName = String(parsed.name ?? '')
          .split(',')[0]
          .replace(/^Foulborn\s+/i, '')
          .trim();
        spec.name = bareName || spec.name;
        spec.rarity = 'unique';
      } else {
        spec.rarity = 'nonunique';
      }

      // Category always scopes the search (a jewel query would otherwise match a
      // ring with the same three mods). The BASE TYPE is different: it is only
      // worth pinning when the base itself carries meaning — jewellery, weapons,
      // jewels, or a base whose implicit defines the item. For ordinary ES/EV/AR
      // armour a base filter throws away every equally good item of a
      // neighbouring base, so the search states a defence minimum instead.
      const category = tradeCategoryFor(String(parsed.type ?? '')) ?? tradeCategoryFor(args.item_slot ?? '');
      if (category) spec.category = category;

      const armourSlot = !!category && category.startsWith('armour.');
      const baseIsMeaningful = !armourSlot || category === 'armour.quiver';
      if (args.same_base === true || (args.same_base !== false && baseIsMeaningful)) {
        if (parsed.base) spec.type = parsed.base;
      }

      if (armourSlot) {
        // Read the defence pool straight off the item text ("Evasion: 191",
        // "Energy Shield: 74") — no base table needed, and a hybrid item asks
        // for both pools.
        const rawText = String(raw);
        const equipment: { ar?: number; ev?: number; es?: number; ward?: number } = {};
        if (/^\s*Armour:/im.test(rawText)) equipment.ar = 1;
        if (/^\s*Evasion:/im.test(rawText)) equipment.ev = 1;
        if (/^\s*Energy Shield:/im.test(rawText)) equipment.es = 1;
        if (/^\s*Ward:/im.test(rawText)) equipment.ward = 1;
        if (Object.keys(equipment).length > 0) spec.equipment = equipment;
      }

      if (parsed.type && /jewel/i.test(String(parsed.type)) && args.min_links === undefined) {
        spec.minLinks = undefined;
      }

      // Eldritch implicits are rolled separately by the buyer (ichor/ember), so
      // requiring the seller's exact eldritch roll narrows the search to almost
      // nothing. If the item carries either eldritch tag, no implicit is pinned.
      const hasEldritch = /Searing Exarch Item|Eater of Worlds Item/i.test(String(raw));
      if (hasEldritch) {
        derivedFrom.push('Item has eldritch implicits — implicit filters skipped (the buyer rolls them).');
      }

      const mapper = deps?.statMapper;
      // Floors come from the slot's NEEDS (what the requirement sheet says this
      // slot must supply), never from the item's own rolls: a high-roll target
      // would otherwise set a threshold the market cannot meet. Life keeps a
      // 70%-of-roll fallback so a 10-life base never shows up.

      // One normalised-text index over every trade stat, built per call.
      const byText = new Map<string, string[]>();
      if (mapper) {
        for (const entry of mapper.getTradeStatIndex()) {
          const key = normalizeModText(String(entry.text ?? ''));
          if (!key) continue;
          const list = byText.get(key) ?? [];
          list.push(entry.id);
          byText.set(key, list);
        }
      }

      const modLines: Array<{ line: string; domain: string }> = [
        ...(hasEldritch ? [] : (parsed.implicits ?? []).map((l: string) => ({ line: l, domain: 'implicit' }))),
        ...(parsed.explicits ?? []).map((l: string) => ({ line: l, domain: 'explicit' })),
        ...(parsed.fractured ?? []).map((l: string) => ({ line: l, domain: 'fractured' })),
        ...(parsed.crafted ?? []).map((l: string) => ({ line: l, domain: 'crafted' })),
      ];

      // Mods stay in by default - the caller decides which to switch off on the trade site.
      const includeMods = args.include_mods ?? true;

      const unmet: string[] = [];
      const needs = args.needs ?? {};
      const OR_MODE = args.or_mode === true;

      // Bucket every mod by intent first; the bucket decides the filter shape.
      const buckets: Record<string, Array<{ line: string; id: string; value: number | null; domain: string }>> = {
        ele_res: [], chaos_res: [], life: [], dex: [], str: [], int: [], other: [],
      };
      for (const { line, domain } of (includeMods ? modLines : [])) {
        const key = normalizeModText(line);
        const candidates = byText.get(key) ?? [];
        const id = candidates.length > 0 ? pickStatId(candidates, domain) : undefined;
        if (!id) {
          unmet.push(line);
          continue;
        }
        // An implicit on a base we already pin adds nothing and only narrows
        // (every Amethyst ring has its chaos implicit).
        if (domain === 'implicit' && spec.type) {
          derivedFrom.push(`${line} -> skipped (base ${spec.type} already pins it)`);
          continue;
        }
        buckets[classifyMod(line)].push({ line, id, value: firstModValue(line), domain });
      }

      const push = (id: string, min: number | undefined, note: string) => {
        const filter: { id: string; min?: number } = { id };
        if (typeof min === 'number' && min > 0) filter.min = min;
        spec.stats!.push(filter);
        derivedFrom.push(note);
      };

      // A floor from the item's own roll: `min_roll_pct` was documented but only
      // ever applied to life, so every resistance/attribute filter came out as
      // presence-only and a buyer could not tell what roll actually closes the
      // cap. The slot's NEEDS always win; the roll is only a fallback.
      const pct = typeof args.min_roll_pct === 'number' && args.min_roll_pct > 0 ? args.min_roll_pct : undefined;
      const floorFromRoll = (roll: number | null | undefined): number | undefined => {
        if (!pct || !roll || roll <= 0) return undefined;
        return Math.max(1, Math.floor(roll * pct));
      };

      // Resistances: the slot's job is a *total*, so any mix of elements counts.
      if (buckets.ele_res.length > 0) {
        if (OR_MODE && buckets.ele_res.length === 1) {
          // "any one of fire / cold / lightning at this threshold"
          const orMin = needs.ele_res ?? floorFromRoll(Math.max(...buckets.ele_res.map((b) => b.value ?? 0)));
          spec.orStats = [
            { id: TRADE_IDS.fireRes, min: orMin },
            { id: TRADE_IDS.coldRes, min: orMin },
            { id: TRADE_IDS.lightRes, min: orMin },
          ].filter((f) => typeof f.min === 'number' && f.min > 0);
          derivedFrom.push(
            `elemental res (${buckets.ele_res.length} line) -> OR group fire/cold/lightning${orMin ? ` (min ${orMin} each)` : ''}`
          );
        } else {
          const rolls = buckets.ele_res.map((b) => b.value ?? 0).reduce((a, b) => a + b, 0);
          const min = needs.ele_res ?? floorFromRoll(rolls);
          push(TRADE_IDS.totalEleRes, min, `elemental res -> pseudo total (min ${min ?? 'none'}; item rolls ${rolls})`);
        }
      }
      if (buckets.life.length > 0) {
        const roll = Math.max(...buckets.life.map((b) => b.value ?? 0));
        const min = needs.life ?? (roll > 0 ? Math.round(roll * (pct ?? 0.7)) : undefined);
        push(TRADE_IDS.totalLife, min, `life -> pseudo total (min ${min ?? 'none'})`);
      }
      for (const bucket of ['chaos_res', 'dex', 'str', 'int'] as const) {
        for (const mod of buckets[bucket]) {
          const need = bucket === 'chaos_res' ? needs.chaos_res : (needs as any)[bucket];
          const min = need ?? floorFromRoll(mod.value);
          push(mod.id, min, `${mod.line} -> ${mod.id}${min ? ` (min ${min})` : ' (no floor)'}`);
        }
      }
      for (const mod of buckets.other) {
        push(mod.id, undefined,
          `${mod.line} -> ${mod.id}` + (mod.domain === 'fractured' && mod.id.startsWith('explicit.') ? '  [fractured mod searched as explicit]' : ''));
      }

      if (unmet.length > 0) {
        derivedFrom.push('', 'No trade stat matched these lines (left out):', ...unmet.map((l) => `  - ${l}`));
      }

      // Two mods can map to the same trade stat (e.g. an Amethyst ring's chaos
      // implicit and its chaos explicit). The trade site rejects a query that
      // repeats a stat id, so merge them and keep the stricter bound.
      const merged = new Map<string, { id: string; min?: number; max?: number; disabled?: boolean }>();
      for (const filter of spec.stats!) {
        const existing = merged.get(filter.id);
        if (!existing) {
          merged.set(filter.id, { ...filter });
          continue;
        }
        if (filter.min !== undefined) {
          existing.min = existing.min === undefined ? filter.min : Math.max(existing.min, filter.min);
        }
        if (filter.max !== undefined) {
          existing.max = existing.max === undefined ? filter.max : Math.min(existing.max, filter.max);
        }
      }
      spec.stats = Array.from(merged.values());
      if (spec.stats.length < modLines.length) {
        derivedFrom.push(`(${modLines.length - spec.stats.length} duplicate stat id(s) merged)`);
      }

      derivedFrom.push('', `Matched against ${byText.size} trade stat texts (mapper ${mapper ? 'loaded' : 'MISSING'}).`);
    }

    const query = args.query ?? buildTradeQuery(spec);

    let url: string;
    let total: number | undefined;
    let via = 'local payload (offline)';

    const wantsApi = args.use_api === true;
    if (wantsApi) {
      if (!deps?.tradeClient) {
        throw new Error('Trade API is not enabled — pass use_api:false for the offline payload, or enable POE_TRADE_ENABLED.');
      }
      const result = await deps.tradeClient.searchItems(args.league, {
        query: query as any,
        sort: { price: 'asc' },
      } as any);
      url = `https://www.pathofexile.com/trade/search/${encodeURIComponent(args.league)}/${result.id}`;
      total = result.total;
      via = 'server-issued search id';
    } else {
      url = buildTradeSearchUrl(args.league, query);
    }

    const parts = [`=== Trade URL (${args.league}) ===`, '', url, ''];
    if (total !== undefined) parts.push(`Matching listings: ${total}`);
    if (derivedFrom.length > 0) {
      parts.push('', 'Filters derived from the item:', ...derivedFrom);
    }
    parts.push(
      '',
      `Link via ${via}.`,
      wantsApi
        ? 'One search request was used; the id comes from the trade site itself.'
        : 'Offline payload; no request was made. Verify it with decode_trade_url before handing it over — a hand-copied payload is the only way this link breaks.',
      'Note: This product is not affiliated with or endorsed by Grinding Gear Games.'
    );

    return { content: [{ type: 'text', text: parts.join('\n') }] };
  });
}

/**
 * Search AND fetch the cheapest listings with their prices in one step.
 *
 * This is the TOS-sensitive path (two API requests: search + fetch), so it is a
 * separate, opt-in tool rather than the default behaviour of
 * `search_trade_items`. Use only when actual prices are needed; if a link is
 * enough, use `generate_trade_url` (zero requests).
 */
export async function handleSearchTradeListings(
  context: TradeContext,
  args: {
    league: string;
    item_name?: string;
    item_type?: string;
    category?: string;
    rarity?: 'normal' | 'magic' | 'rare' | 'unique' | 'nonunique' | 'any';
    min_links?: number;
    stats?: Array<{ id: string; min?: number; max?: number }>;
    mods?: Array<{ stat_id: string; min?: number; max?: number }>;
    max_price?: number;
    price_currency?: string;
    limit?: number;
  }
): Promise<{
  content: Array<{
    type: string;
    text: string;
  }>;
}> {
  return wrapHandler('search trade listings', async () => {
    const {
      league,
      item_name,
      item_type,
      category,
      rarity,
      min_links,
      stats,
      mods,
      max_price,
      price_currency = 'chaos',
      limit = 5,
    } = args;

    const builder = new TradeQueryBuilder();
    if (item_name) builder.withName(item_name);
    if (item_type) builder.withType(item_type);
    if (rarity && rarity !== 'any') builder.withRarity(rarity as any);
    if (min_links) builder.withLinks(min_links);

    const statFilters = toStatFilters(stats, mods);
    if (statFilters.length > 0) builder.withStats(statFilters);

    if (category) {
      // Category is not part of the public builder API; attach it directly to
      // the built query so callers can scope a search to `armour.shield` etc.
      builder.applyOptions({ league, sort: 'price_asc', limit });
      const query = builder.build();
      query.query.filters = query.query.filters ?? {};
      query.query.filters.type_filters = query.query.filters.type_filters ?? { filters: {} };
      (query.query.filters.type_filters as any).filters = {
        ...((query.query.filters.type_filters as any).filters ?? {}),
        category: { option: category },
      };
      if (rarity && rarity !== 'any') {
        (query.query.filters.type_filters as any).filters.rarity = { option: rarity };
      }
      if (max_price) {
        query.query.filters.trade_filters = {
          filters: { price: { min: 0, max: max_price, option: price_currency } as any },
        };
      }
      const result = await context.tradeClient.searchItems(league, query);
      return formatListingsResponse(league, result, context, limit);
    }

    builder.applyOptions({ league, maxPrice: max_price, priceCurrency: price_currency, sort: 'price_asc', limit });
    const query = builder.build();
    const result = await context.tradeClient.searchItems(league, query);
    return formatListingsResponse(league, result, context, limit);
  });
}

async function formatListingsResponse(
  league: string,
  searchResult: { id: string; total: number; result: string[] },
  context: TradeContext,
  limit: number
): Promise<{ content: Array<{ type: string; text: string }> }> {
  if (!searchResult.result || searchResult.result.length === 0) {
    return { content: [{ type: 'text', text: `No items found in ${league}.` }] };
  }

  const ids = searchResult.result.slice(0, Math.min(limit, 10));
  const listings = await context.tradeClient.fetchItems(ids, searchResult.id);

  const lines: string[] = [
    `=== Cheapest listings (${league}) ===`,
    `Total matching: ${searchResult.total}`,
    '',
  ];

  for (const listing of listings) {
    const amount = listing.listing?.price?.amount;
    const currency = listing.listing?.price?.currency;
    const price = amount !== undefined ? `${amount} ${currency}` : 'no price';
    const mods = (listing.item?.explicitMods ?? []).slice(0, 6).join(' | ');
    lines.push(`• ${price} — ${listing.item?.typeLine ?? '?'}`);
    if (mods) lines.push(`   ${mods}`);
  }

  lines.push('', `🔗 ${getTradeSearchUrl(league, searchResult.id)}`);
  lines.push('Note: This product is not affiliated with or endorsed by Grinding Gear Games.');

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

/**
 * Report the trade API rate-limit state for this server process.
 * Call it before a batch of searches instead of discovering the limit the hard
 * way (a tripped limit blocks every request for a minute or more).
 */
export async function handleTradeRateLimit(context: TradeContext): Promise<{
  content: Array<{ type: string; text: string }>;
}> {
  return wrapHandler('trade rate limit', async () => {
    const info = context.tradeClient.getRateLimitInfo();
    if (!info) {
      return {
        content: [
          {
            type: 'text',
            text: 'No trade API request has been made yet in this session — no rate-limit data to report.',
          },
        ],
      };
    }
    const lines = [
      '=== Trade API rate limit (per IP) ===',
      `Window limit : ${info.limit}`,
      `Remaining    : ${info.remaining}`,
      info.retryAfter ? `Retry after  : ${info.retryAfter} ms` : 'Retry after  : —',
    ];
    if (info.remaining <= 0) {
      lines.push('', '⛔ Quota exhausted — wait for the window to reset before searching again.');
      lines.push('Use generate_trade_url (no API) meanwhile.');
    } else if (info.remaining <= 2) {
      lines.push('', '⚠️ Nearly exhausted. Prefer generate_trade_url over more searches.');
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });
}

/**
 * Batch generation: build links for several slots at once, verify every one by
 * decoding it back, and write a markdown file. Returning a path instead of a
 * wall of 400-character strings is the whole point — a hand-copied payload is
 * the only way these links ever break.
 */
export async function handleGenerateTradeUrls(
  args: {
    league: string;
    slots?: string[];
    items?: Array<{ label: string; item_slot?: string; item_text?: string; needs?: SlotNeeds; or_mode?: boolean; corrupted?: boolean }>;
    out_file?: string;
    use_api?: boolean;
    include_mods?: boolean;
    min_roll_pct?: number;
  },
  deps?: {
    statMapper?: StatMapper;
    getLuaClient?: () => AnyLuaClient | null;
    ensureLuaClient?: () => Promise<void>;
    tradeClient?: TradeApiClient;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  return wrapHandler('generate trade urls', async () => {
    if (!args.league) throw new Error('Missing required argument: league');

    const targets: Array<{ label: string; item_slot?: string; item_text?: string; needs?: SlotNeeds; or_mode?: boolean; corrupted?: boolean }> =
      args.items && args.items.length > 0
        ? args.items
        : (args.slots ?? []).map((s) => ({ label: s, item_slot: s }));

    if (targets.length === 0) {
      throw new Error('Provide `slots` (equipped slot names) or `items` (label + item_slot/item_text).');
    }

    const rows: Array<{ label: string; url: string; verified: boolean; note?: string }> = [];

    for (const target of targets) {
      const singleRes = await handleGenerateTradeUrl(
        {
          league: args.league,
          item_slot: target.item_slot,
          item_text: target.item_text,
          use_api: args.use_api,
          include_mods: args.include_mods,
          min_roll_pct: args.min_roll_pct,
          needs: target.needs,
          or_mode: target.or_mode,
          corrupted: target.corrupted,
        },
        deps
      );
      const single = singleRes.content?.[0]?.text ?? '';
      const match = single.match(/https:\/\/\S+/);
      if (!match) {
        rows.push({ label: target.label, url: '', verified: false, note: 'no URL produced' });
        continue;
      }
      const check = decodeTradeUrl(match[0]);
      rows.push({
        label: target.label,
        url: match[0],
        verified: check.ok,
        note: check.ok ? undefined : (check as DecodedTradeUrlErr).error,
      });
    }

    const outFile = args.out_file || path.join(process.cwd(), 'trade_links.md');
    const lines = [
      `# Trade links (${args.league})`,
      '',
      `Generated ${new Date().toISOString()} — every link verified by decoding it back.`,
      args.use_api ? 'Mode: server-issued ids.' : 'Mode: local payloads (no API requests).',
      '',
    ];
    for (const row of rows) {
      lines.push(`## ${row.label}`);
      lines.push(row.url || '(failed)');
      if (!row.verified) lines.push(`> NOT VERIFIED: ${row.note}`);
      lines.push('');
    }
    await fs.writeFile(outFile, lines.join('\n'), 'utf8');

    const failed = rows.filter((r) => !r.verified);
    const summary = [
      `=== Generated ${rows.length} link(s) → ${outFile} ===`,
      `Verified: ${rows.length - failed.length}/${rows.length}`,
      ...failed.map((r) => `FAILED: ${r.label} — ${r.note}`),
    ].join('\n');

    return { content: [{ type: 'text', text: summary }] };
  });
}

/** Decode a trade link someone handed us, and report what it actually contains. */
export async function handleDecodeTradeUrl(args: { url?: string; payload?: string }): Promise<{
  content: Array<{ type: string; text: string }>;
}> {
  return wrapHandler('decode trade url', async () => {
    const input = args.url ?? args.payload;
    if (!input) throw new Error('Provide `url` or `payload`.');
    const decoded = decodeTradeUrl(input);
    if (!decoded.ok) {
      return {
        content: [
          {
            type: 'text',
            text:
              `=== Trade URL: INVALID ===\n${decoded.error}\n` +
              `payload length: ${decoded.payloadLength}\n\n` +
              'This is the signature of a hand-copied/mangled payload, not of a bad query format.',
          },
        ],
      };
    }
    const q: any = decoded.query;
    const filters = q?.stats?.[0]?.filters ?? [];
    const text = [
      '=== Trade URL: valid ===',
      `status     : ${q?.status?.option ?? '—'}${q?.status?.option === 'securable' ? '  (Instant Buyout)' : ''}`,
      `name/type  : ${q?.name ?? '—'} / ${q?.type ?? '—'}`,
      `category   : ${q?.filters?.type_filters?.filters?.category?.option ?? '—'}`,
      `rarity     : ${q?.filters?.type_filters?.filters?.rarity?.option ?? '—'}`,
      `stat filters: ${filters.length}`,
      ...filters.map((f: any) => `  - ${f.id}${f.value && Object.keys(f.value).length ? ` ${JSON.stringify(f.value)}` : ''}`),
      '',
      JSON.stringify(q),
    ].join('\n');
    return { content: [{ type: 'text', text }] };
  });
}

/**
 * Get current market price for an item
 */
export async function handleGetItemPrice(
  context: TradeContext,
  args: {
    item_name: string;
    league?: string;
    item_type?: string;
    rarity?: 'unique' | 'rare' | 'magic' | 'normal';
  }
): Promise<{
  content: Array<{
    type: string;
    text: string;
  }>;
}> {
  return wrapHandler('get item price', async () => {
    const { item_name, item_type, rarity } = args;
    const league = resolveLeague(args.league);

    // For named items (uniques, currency, gems, div cards) prefer poe.ninja —
    // zero GGG API calls. For rare/unknown items fall back to a trade URL.
    // We deliberately do NOT fetch listings from the trade API; see legal_considerations.md §TOS.
    if (context.ninjaClient && (!rarity || rarity === 'unique')) {
      try {
        const ninjaRates = await context.ninjaClient.getCurrencyExchangeMap(league);
        const ninjaPrice = ninjaRates.get(item_name);
        if (ninjaPrice !== undefined) {
          return {
            content: [{
              type: 'text',
              text: `=== Price Check: ${item_name} (poe.ninja) ===\nLeague: ${league}\nPrice: ${ninjaPrice.toFixed(1)} chaos\nNote: This product is not affiliated with or endorsed by Grinding Gear Games.`,
            }],
          };
        }
      } catch {
        // poe.ninja unavailable — fall through to trade URL
      }
    }

    // Fall back: build trade URL (one search POST, no listing fetch)
    const builder = new TradeQueryBuilder()
      .withName(item_name)
      .withOnlineStatus('available');

    if (item_type) builder.withType(item_type);
    if (rarity) builder.withRarity(rarity);
    builder.withSort('price', 'asc');

    const query = builder.build();
    const searchResult = await context.tradeClient.searchItems(league, query);

    if (!searchResult.result || searchResult.result.length === 0) {
      return {
        content: [{ type: 'text', text: `No listings found for "${item_name}" in ${league}.` }],
      };
    }

    const url = getTradeSearchUrl(league, searchResult.id);
    return {
      content: [{
        type: 'text',
        text: `=== Price Check: ${item_name} ===\nLeague: ${league}\nTotal listings: ${searchResult.total}\n\n🔗 ${url}\n\nOpen the link above to see current prices.\nNote: This product is not affiliated with or endorsed by Grinding Gear Games.`,
      }],
    };
  });
}

/**
 * Get available leagues
 */
export async function handleGetLeagues(
  context: TradeContext
): Promise<{
  content: Array<{
    type: string;
    text: string;
  }>;
}> {
  return wrapHandler('get leagues', async () => {
    const leagueData = await context.tradeClient.getLeagues();

    if (!leagueData.result || leagueData.result.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No leagues found.',
          },
        ],
      };
    }

    let output = '=== Available Leagues ===\n\n';

    for (const league of leagueData.result) {
      output += `- ${league.id}`;
      if (league.text) {
        output += ` (${league.text})`;
      }
      if (league.realm) {
        output += ` [${league.realm}]`;
      }
      output += '\n';
    }

    return {
      content: [
        {
          type: 'text',
          text: output,
        },
      ],
    };
  });
}

// ========================================
// Helper Functions
// ========================================

/**
 * Fetch and map currency rates from poe.ninja
 * Maps full currency names to short names used by trade API
 */
async function getCurrencyRatesMap(ninjaClient: PoeNinjaClient | undefined, league: string): Promise<Map<string, number>> {
  if (!ninjaClient) {
    return new Map();
  }

  try {
    const rates = await ninjaClient.getCurrencyExchangeMap(league);

    // Map poe.ninja names to trade API currency names
    const mappedRates = new Map<string, number>();

    // Common currency mappings
    const nameMap: Record<string, string[]> = {
      'Divine Orb': ['divine', 'div'],
      'Chaos Orb': ['chaos', 'c'],
      'Exalted Orb': ['exalted', 'exa', 'ex'],
      'Mirror of Kalandra': ['mirror'],
      'Orb of Alchemy': ['alchemy', 'alch'],
      'Orb of Fusing': ['fusing', 'fuse'],
      'Orb of Regret': ['regret'],
      'Gemcutter\'s Prism': ['gcp'],
      'Chromatic Orb': ['chrome', 'chromatic'],
      'Jeweller\'s Orb': ['jewellers', 'jew'],
      'Orb of Alteration': ['alt', 'alteration'],
      'Vaal Orb': ['vaal'],
      'Cartographer\'s Chisel': ['chisel'],
      'Blessed Orb': ['blessed'],
      'Orb of Scouring': ['scouring', 'scour'],
    };

    // Add mappings
    for (const [fullName, chaosValue] of rates.entries()) {
      // Add the full name
      mappedRates.set(fullName, chaosValue);

      // Add short name mappings
      for (const [key, aliases] of Object.entries(nameMap)) {
        if (fullName === key) {
          for (const alias of aliases) {
            mappedRates.set(alias, chaosValue);
          }
        }
      }
    }

    return mappedRates;
  } catch (error) {
    console.error('[Trade] Failed to fetch currency rates from poe.ninja:', error);
    return new Map();
  }
}

async function formatSearchResults(items: ItemListing[], totalResults: number, league: string, searchId: string, ninjaClient?: PoeNinjaClient): Promise<string> {
  let output = `=== Trade Search (${league}) ===\n`;
  output += `Found: ${totalResults} | Showing: ${items.length}\n`;
  output += `🔗 ${getTradeSearchUrl(league, searchId)}\n\n`;

  // Fetch real-time currency rates from poe.ninja
  const currencyRates = await getCurrencyRatesMap(ninjaClient, league);

  // Analyze items for cost/benefit with real rates
  const analyzer = new CostBenefitAnalyzer();
  const analyses = analyzer.analyzeAndRank(items, currencyRates);

  for (let i = 0; i < analyses.length; i++) {
    const analysis = analyses[i];
    const listing = analysis.listing;
    const item = listing.item;
    const price = listing.listing.price;
    const seller = listing.listing.account;
    const metrics = analysis.metrics;

    // Rank by value, not by search order
    const valueRank = analysis.rank || (i + 1);
    const searchRank = items.indexOf(listing) + 1;

    output += `${searchRank}. ${item.name || item.typeLine}`;

    // Show value indicator
    const tierEmoji = {
      'excellent': ' 💎',
      'good': ' ✨',
      'average': '',
      'poor': ' ⚠️'
    }[metrics.valueTier];
    output += tierEmoji;

    if (metrics.isBudgetPick) {
      output += ' 💰';
    }

    output += `\n`;

    if (item.name && item.typeLine && item.name !== item.typeLine) {
      output += `   Base: ${item.typeLine}\n`;
    }

    if (price) {
      output += `   Price: ${price.amount} ${price.currency}`;
      if (analysis.priceInChaos > 0 && price.currency !== 'chaos') {
        output += ` (~${analysis.priceInChaos.toFixed(0)} chaos)`;
      }
      output += `\n`;
    } else {
      output += `   Price: Not listed\n`;
    }

    // Show value score
    output += `   Value: ${metrics.valueScore.toFixed(0)}/100 (${metrics.valueTier})`;
    if (valueRank <= 3) {
      output += ` - #${valueRank} best value`;
    }
    output += `\n`;

    output += `   ilvl: ${item.ilvl}`;

    if (item.corrupted) {
      output += ' (Corrupted)';
    }

    output += '\n';

    // Links
    if (item.sockets && item.sockets.length > 0) {
      const maxLinks = getMaxLinks(item.sockets);
      if (maxLinks > 1) {
        output += `   Links: ${maxLinks}L\n`;
      }
    }

    // Show key stats in condensed format
    const stats = analysis.stats;
    const statParts: string[] = [];
    if (stats.life > 0) statParts.push(`+${stats.life} Life`);
    if (stats.es > 0) statParts.push(`+${stats.es} ES`);
    if (stats.totalResist > 0) statParts.push(`+${stats.totalResist}% Res`);
    if (statParts.length > 0) {
      output += `   Stats: ${statParts.join(', ')}\n`;
    }

    output += `   ${seller.online ? '🟢' : '🔴'} ${seller.name}\n`;
    output += `   🔗 ${getTradeItemUrl(league, searchId, listing.id)}\n\n`;
  }

  output += `\n💎=excellent ✨=good ⚠️=poor 💰=budget 🟢=online 🔴=offline`;
  return output;
}

function getMaxLinks(sockets: Array<{ group: number }>): number {
  const groups = new Map<number, number>();
  for (const socket of sockets) {
    const count = groups.get(socket.group) || 0;
    groups.set(socket.group, count + 1);
  }
  return Math.max(...groups.values());
}

/**
 * Search for stat IDs by name (fuzzy matching)
 */
export async function handleSearchStats(
  context: TradeContext,
  args: {
    query: string;
    limit?: number;
  }
): Promise<{
  content: Array<{
    type: string;
    text: string;
  }>;
}> {
  return wrapHandler('search stats', async () => {
    const { query, limit = 10 } = args;

    if (!context.statMapper) {
      return {
        content: [
          {
            type: 'text',
            text: 'Stat mapper not available.',
          },
        ],
      };
    }

    const results = context.statMapper.fuzzySearch(query, limit);

    if (results.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No stats found matching "${query}".`,
          },
        ],
      };
    }

    let output = `=== Stat Search Results for "${query}" ===\n\n`;
    output += `Found ${results.length} matching stats:\n\n`;

    for (let i = 0; i < results.length; i++) {
      const stat = results[i];
      output += `${i + 1}. ${stat.pobName}\n`;
      output += `   Trade ID: ${stat.tradeId}\n`;
      output += `   Category: ${stat.category}\n`;

      if (stat.description) {
        output += `   Description: ${stat.description}\n`;
      }

      if (stat.aliases.length > 0) {
        output += `   Aliases: ${stat.aliases.slice(0, 3).join(', ')}`;
        if (stat.aliases.length > 3) {
          output += ` (+${stat.aliases.length - 3} more)`;
        }
        output += '\n';
      }

      output += '\n';
    }

    output += `\nTo use in searches, reference the Trade ID in the stats parameter.`;

    return {
      content: [
        {
          type: 'text',
          text: output,
        },
      ],
    };
  });
}

// Phase 3: Recommendation Engine Handlers

export async function handleFindItemUpgrades(
  context: TradeContext,
  args: any
): Promise<{ content: Array<{ type: string; text: string }> }> {
  return wrapHandler('find item upgrades', async () => {
    const {
      slot,
      league,
      build_needs,
      current_item,
      max_price = 100,
      currency = 'chaos',
      limit = 5,
    } = args;

    if (!context.recommendationEngine) {
      return {
        content: [{ type: 'text', text: 'Recommendation engine not available.' }],
      };
    }

    const upgradeContext: UpgradeContext = {
      currentItem: current_item ? {
        name: current_item.name || 'Current Item',
        slot,
        life: current_item.life,
        es: current_item.es,
        resistances: {
          fire: current_item.fire_resist,
          cold: current_item.cold_resist,
          lightning: current_item.lightning_resist,
          chaos: current_item.chaos_resist,
        },
      } : undefined,
      buildNeeds: {
        lifeNeeded: build_needs?.life,
        esNeeded: build_needs?.es,
        dpsTarget: build_needs?.dps,
        resistanceGaps: (build_needs && (build_needs.fire_resist || build_needs.cold_resist || build_needs.lightning_resist)) ? {
          fire: build_needs.fire_resist || 0,
          cold: build_needs.cold_resist || 0,
          lightning: build_needs.lightning_resist || 0,
          chaos: build_needs.chaos_resist || 0,
        } : undefined,
      },
      budget: {
        maxPricePerItem: max_price,
        totalBudget: max_price * 2,
        currency,
      },
      league,
    };

    const recommendations = await context.recommendationEngine.findUpgrades(slot, upgradeContext);

    if (recommendations.length === 0) {
      return {
        content: [{ type: 'text', text: `No upgrade recommendations found for ${slot} in ${league} within budget.` }],
      };
    }

    const output = formatItemRecommendations(recommendations.slice(0, limit), slot, league);
    return { content: [{ type: 'text', text: output }] };
  });
}

export async function handleFindResistanceGear(
  context: TradeContext,
  args: any
): Promise<{ content: Array<{ type: string; text: string }> }> {
  return wrapHandler('find resistance gear', async () => {
    const {
      league,
      fire_resist_needed = 0,
      cold_resist_needed = 0,
      lightning_resist_needed = 0,
      chaos_resist_needed = 0,
      max_price_per_item = 50,
      total_budget = 200,
      currency = 'chaos',
      slots,
      limit = 8,
    } = args;

    if (!context.recommendationEngine) {
      return {
        content: [{ type: 'text', text: 'Recommendation engine not available.' }],
      };
    }

    const resistanceGaps: ResistanceRequirements = {
      fire: fire_resist_needed,
      cold: cold_resist_needed,
      lightning: lightning_resist_needed,
      chaos: chaos_resist_needed,
    };

    const budget: BudgetConstraints = {
      maxPricePerItem: max_price_per_item,
      totalBudget: total_budget,
      currency,
    };

    const recommendations = await context.recommendationEngine.findResistanceGear(
      resistanceGaps,
      budget,
      league,
      slots
    );

    if (recommendations.length === 0) {
      return {
        content: [{ type: 'text', text: `No resistance gear found in ${league} that matches your requirements within budget.` }],
      };
    }

    const output = formatResistanceRecommendations(recommendations.slice(0, limit), resistanceGaps, league, true);
    return { content: [{ type: 'text', text: output }] };
  });
}

function formatItemRecommendations(
  recommendations: ItemRecommendation[],
  slot: string,
  league: string,
  includeLinks: boolean = false
): string {
  let output = `=== ${slot} Upgrades (${league}) ===\n`;
  output += `${recommendations.length} found\n\n`;

  for (const rec of recommendations) {
    const item = rec.listing.item;
    const price = rec.listing.listing.price;

    output += `${rec.rank}. ${item.name || item.typeLine}`;
    if (rec.priority === 'high') output += ' ⭐';
    output += `\n`;

    if (item.name && item.typeLine && item.name !== item.typeLine) {
      output += `   Base: ${item.typeLine}\n`;
    }

    output += `   Score: ${rec.score.toFixed(1)}/100 (${rec.priority} priority)\n`;

    if (price) {
      output += `   Price: ${price.amount} ${price.currency}\n`;
    }

    if (rec.costBenefit) {
      const cb = rec.costBenefit;
      if (cb.lifeGain && cb.lifeGain > 0) {
        output += `   Life Gain: +${cb.lifeGain}\n`;
      }
      if (cb.esGain && cb.esGain > 0) {
        output += `   ES Gain: +${cb.esGain}\n`;
      }
      if (cb.efficiency) {
        output += `   Efficiency: ${cb.efficiency.toFixed(2)} points per ${cb.currency}\n`;
      }
    }

    if (rec.reasons.length > 0) {
      output += `   Why:\n`;
      for (const reason of rec.reasons.slice(0, 3)) {
        output += `     - ${reason}\n`;
      }
    }

    output += `   ${rec.listing.listing.account.online ? '🟢' : '🔴'} ${rec.listing.listing.account.name}\n`;
    output += `   🔗 ${getTradeItemUrl(league, rec.searchId, rec.listing.id)}\n\n`;
  }

  return output;
}

function formatResistanceRecommendations(
  recommendations: ItemRecommendation[],
  resistanceGaps: ResistanceRequirements,
  league: string,
  includeLinks: boolean = false
): string {
  const targets = [];
  if (resistanceGaps.fire > 0) targets.push(`${resistanceGaps.fire}% Fire`);
  if (resistanceGaps.cold > 0) targets.push(`${resistanceGaps.cold}% Cold`);
  if (resistanceGaps.lightning > 0) targets.push(`${resistanceGaps.lightning}% Lightning`);
  if (resistanceGaps.chaos && resistanceGaps.chaos > 0) targets.push(`${resistanceGaps.chaos}% Chaos`);

  let output = `=== Resistance Gear (${league}) ===\n`;
  output += `Need: ${targets.join(', ')}\n`;
  output += `${recommendations.length} found\n\n`;

  for (const rec of recommendations) {
    const item = rec.listing.item;
    const price = rec.listing.listing.price;

    output += `${rec.rank}. ${item.name || item.typeLine}`;
    if (rec.priority === 'high') output += ' ⭐';
    output += `\n`;

    if (item.typeLine && item.name !== item.typeLine) {
      output += `   Type: ${item.typeLine}\n`;
    }

    output += `   Score: ${rec.score.toFixed(1)}/100 (${rec.priority} priority)\n`;

    if (price) {
      output += `   Price: ${price.amount} ${price.currency}\n`;
    }

    if (rec.costBenefit.resistGain) {
      const gains = [];
      const rg = rec.costBenefit.resistGain;
      if (rg.fire) gains.push(`${rg.fire}% Fire`);
      if (rg.cold) gains.push(`${rg.cold}% Cold`);
      if (rg.lightning) gains.push(`${rg.lightning}% Lightning`);
      if (rg.chaos) gains.push(`${rg.chaos}% Chaos`);

      if (gains.length > 0) {
        output += `   Provides: ${gains.join(', ')}\n`;
      }
    }

    if (rec.costBenefit.efficiency) {
      output += `   Efficiency: ${rec.costBenefit.efficiency.toFixed(2)} resist per ${rec.costBenefit.currency}\n`;
    }

    if (rec.reasons.length > 0) {
      output += `   Why:\n`;
      for (const reason of rec.reasons.slice(0, 2)) {
        output += `     - ${reason}\n`;
      }
    }

    output += `   ${rec.listing.listing.account.online ? '🟢' : '🔴'} ${rec.listing.listing.account.name}\n`;
    output += `   🔗 ${getTradeItemUrl(league, rec.searchId, rec.listing.id)}\n\n`;
  }

  return output;
}

/**
 * Compare multiple trade items side-by-side
 */
export async function handleCompareTradeItems(
  context: TradeContext,
  args: {
    item_ids: string[];
    build_context?: {
      life_needed?: number;
      es_needed?: number;
      dps_target?: number;
      fire_resist_needed?: number;
      cold_resist_needed?: number;
      lightning_resist_needed?: number;
    };
  }
): Promise<{
  content: Array<{
    type: string;
    text: string;
  }>;
}> {
  return wrapHandler('compare trade items', async () => {
    const { item_ids, build_context } = args;

    if (!item_ids || item_ids.length === 0) {
      return {
        content: [{ type: 'text', text: 'No item IDs provided for comparison.' }],
      };
    }

    if (item_ids.length > 5) {
      return {
        content: [{ type: 'text', text: 'Can only compare up to 5 items at once.' }],
      };
    }

    const items = await context.tradeClient.fetchItems(item_ids);

    if (items.length === 0) {
      return {
        content: [{ type: 'text', text: 'No items found with the provided IDs.' }],
      };
    }

    const output = formatItemComparison(items, build_context);
    return { content: [{ type: 'text', text: output }] };
  });
}

function formatItemComparison(
  items: ItemListing[],
  buildContext?: {
    life_needed?: number;
    es_needed?: number;
    dps_target?: number;
    fire_resist_needed?: number;
    cold_resist_needed?: number;
    lightning_resist_needed?: number;
  }
): string {
  let output = `=== Item Comparison (${items.length}) ===\n\n`;

  const itemStats = items.map(listing => {
    const item = listing.item;
    const price = listing.listing.price;

    return {
      name: item.name || item.typeLine,
      typeLine: item.typeLine,
      price: price ? price.amount + ' ' + price.currency : 'No price',
      priceAmount: price?.amount || 0,
      ilvl: item.ilvl,
      corrupted: item.corrupted || false,
      links: item.sockets ? getMaxLinks(item.sockets) : 0,
      life: extractStatValue(item, 'life'),
      es: extractStatValue(item, 'energy shield'),
      armour: extractStatValue(item, 'armour'),
      evasion: extractStatValue(item, 'evasion'),
      fireResist: extractResistValue(item, 'fire'),
      coldResist: extractResistValue(item, 'cold'),
      lightningResist: extractResistValue(item, 'lightning'),
      chaosResist: extractResistValue(item, 'chaos'),
      seller: listing.listing.account.name,
      online: listing.listing.account.online,
    };
  });

  const maxLife = Math.max(...itemStats.map(i => i.life));
  const maxES = Math.max(...itemStats.map(i => i.es));
  const minPrice = Math.min(...itemStats.filter(i => i.priceAmount > 0).map(i => i.priceAmount));

  for (let i = 0; i < itemStats.length; i++) {
    const stats = itemStats[i];
    output += (i + 1) + '. ' + stats.name + '\n';

    if (stats.name !== stats.typeLine) {
      output += '   Base: ' + stats.typeLine + '\n';
    }

    output += '   Price: ' + stats.price;
    if (stats.priceAmount === minPrice && minPrice > 0) {
      output += ' 💰 (Best Value)';
    }
    output += '\n';

    output += '   ilvl: ' + stats.ilvl;
    if (stats.corrupted) output += ' (Corrupted)';
    output += '\n';

    if (stats.links > 0) {
      output += '   Links: ' + stats.links + 'L\n';
    }

    if (stats.life > 0) {
      output += '   Life: +' + stats.life;
      if (stats.life === maxLife) output += ' ⭐';
      if (buildContext?.life_needed && stats.life >= buildContext.life_needed) {
        output += ' ✓';
      }
      output += '\n';
    }

    if (stats.es > 0) {
      output += '   ES: +' + stats.es;
      if (stats.es === maxES) output += ' ⭐';
      if (buildContext?.es_needed && stats.es >= buildContext.es_needed) {
        output += ' ✓';
      }
      output += '\n';
    }

    if (stats.armour > 0) {
      output += '   Armour: ' + stats.armour + '\n';
    }

    if (stats.evasion > 0) {
      output += '   Evasion: ' + stats.evasion + '\n';
    }

    const resists = [];
    if (stats.fireResist > 0) {
      let resistStr = stats.fireResist + '% Fire';
      if (buildContext?.fire_resist_needed && stats.fireResist >= buildContext.fire_resist_needed) {
        resistStr += ' ✓';
      }
      resists.push(resistStr);
    }
    if (stats.coldResist > 0) {
      let resistStr = stats.coldResist + '% Cold';
      if (buildContext?.cold_resist_needed && stats.coldResist >= buildContext.cold_resist_needed) {
        resistStr += ' ✓';
      }
      resists.push(resistStr);
    }
    if (stats.lightningResist > 0) {
      let resistStr = stats.lightningResist + '% Lightning';
      if (buildContext?.lightning_resist_needed && stats.lightningResist >= buildContext.lightning_resist_needed) {
        resistStr += ' ✓';
      }
      resists.push(resistStr);
    }
    if (stats.chaosResist > 0) {
      resists.push(stats.chaosResist + '% Chaos');
    }

    if (resists.length > 0) {
      output += '   Resistances: ' + resists.join(', ') + '\n';
    }

    output += '   Seller: ' + stats.seller;
    if (stats.online) output += ' (Online)';
    output += '\n\n';
  }

  output += '=== Summary ===\n';
  output += '⭐ = Best value for that stat\n';
  output += '✓ = Meets build requirement\n';
  output += '💰 = Cheapest option\n';

  return output;
}

function extractStatValue(item: any, statName: string): number {
  const allMods = [
    ...(item.explicitMods || []),
    ...(item.implicitMods || []),
    ...(item.craftedMods || []),
  ];

  for (const mod of allMods) {
    if (mod.toLowerCase().includes(statName.toLowerCase())) {
      const match = mod.match(/(\d+)/);
      if (match) {
        return parseInt(match[1], 10);
      }
    }
  }

  return 0;
}

function extractResistValue(item: any, element: string): number {
  const allMods = [
    ...(item.explicitMods || []),
    ...(item.implicitMods || []),
    ...(item.craftedMods || []),
  ];

  let total = 0;

  for (const mod of allMods) {
    const lowerMod = mod.toLowerCase();

    if (lowerMod.includes(element + ' resistance')) {
      const match = mod.match(/\+?(\d+)%/);
      if (match) total += parseInt(match[1], 10);
    }

    if ((element === 'fire' || element === 'cold' || element === 'lightning') &&
        (lowerMod.includes('all elemental resistances') || lowerMod.includes('to all resistances'))) {
      const match = mod.match(/\+?(\d+)%/);
      if (match) total += parseInt(match[1], 10);
    }
  }

  return total;
}

/**
 * Find best-in-slot trade items for the loaded PoB build using PoB's
 * TradeQueryGenerator weighted-search engine. Generates a query JSON keyed by
 * real DPS/eHP impact for the build, then executes it against the PoE trade API.
 */
export async function handleFindWeightedTradeItems(
  context: WeightedTradeContext,
  args: {
    league: string;
    slot: string;
    options?: Record<string, unknown>;
    limit?: number;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  return wrapHandler('find weighted trade items', async () => {
    const { league, slot, options, limit = 5 } = args;
    if (!league) throw new Error('league is required');
    if (!slot) throw new Error('slot is required (e.g. "Belt", "Ring 1", "Body Armour")');

    await context.ensureLuaClient();
    const luaClient = context.getLuaClient();
    if (!luaClient) throw new Error('Lua client not initialized — load a build first');

    const { query: pobQuery, warning } = await luaClient.generateWeightedTradeQuery(slot, options);
    if (!pobQuery || typeof pobQuery !== 'object') {
      throw new Error(`PoB returned no query JSON${warning ? ` (${warning})` : ''}`);
    }

    // PoB's TradeQueryGenerator may produce a status value the trade API rejects.
    // Override to a known-good value before submitting.
    const normalizedQuery = pobQuery as Record<string, any>;
    if (normalizedQuery.query) {
      normalizedQuery.query.status = { option: 'online' };
    }
    const searchResult = await context.tradeClient.searchItems(league, normalizedQuery as unknown as TradeQuery);

    if (!searchResult.result || searchResult.result.length === 0) {
      const empty =
        `=== Weighted BIS Search (${league}, slot: ${slot}) ===\n` +
        `No items found.\n` +
        (warning ? `Warning: ${warning}\n` : '') +
        `Query had ${(pobQuery as any)?.query?.stats?.[0]?.filters?.length ?? '?'} weighted mods.\n`;
      return { content: [{ type: 'text', text: empty }] };
    }

    // Return the trade URL only — do NOT fetch listings. This follows the
    // ExileExchange pattern (one search POST → URL returned to user) and avoids
    // the chained-fetch pattern GGG objects to. See legal_considerations.md §TOS.
    const url = getTradeSearchUrl(league, searchResult.id);
    let output = `=== Weighted BIS Search (${league}, slot: ${slot}) ===\n`;
    output += `Total matches: ${searchResult.total}\n`;
    if (warning) output += `Warning: ${warning}\n`;
    output += `\n🔗 ${url}\n`;
    output += `\nQuery weighted by PoB's TradeQueryGenerator for your loaded build.\n`;
    output += `Open the link above to browse results on the trade site.\n`;
    output += `Note: This product is not affiliated with or endorsed by Grinding Gear Games.`;

    return { content: [{ type: 'text', text: output }] };
  });
}
