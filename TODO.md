# pob-mcp — Future Work & Non-Goals

This file tracks what's genuinely open, what we've deliberately decided *not*
to build (and why), and a short record of major pivots so the reasoning isn't
lost. If you're wondering "why didn't they just do X?", the **Deliberately not
doing** section is probably your answer.

---

## Open

### Console bidirectional communication (`poll_console_messages`)

Let the user type messages to Claude directly from PoB's in-game console
(`~` key) without switching windows — e.g. `claude this build feels squishy,
can you fix defenses`.

**Approach:**
- `ConRegisterFunc("claude", handler)` in `TcpServer.lua` to capture typed
  `claude <message>` commands into a Lua queue.
- New Lua action `poll_console_messages` returns and clears the queue.
- Claude polls it at session start or periodically (could ride on the existing
  `start_watching` cadence).

**Status:** not started. Self-contained, moderate effort. The main unknown is
whether SimpleGraphic's console API exposes a registration hook usable from the
API layer.

### Per-skill damage attribution for `get_stat_breakdown`

`get_stat_breakdown` is accurate for **unconditional** stats (life, resists,
attributes, armour/ES, regen) because it tabulates the player modDB with a nil
config. It is **incomplete for damage and other skill-conditional stats**
(`AttackSpeed`, `CastSpeed`, hit/DoT damage) — those mods depend on the active
skill's calc config, which the current action doesn't thread through, so they
return empty or partial.

**What it would take:** build (or borrow) the active skill's `cfg` from
`mainEnv` and pass it into the `Tabulate` calls, plus decide how to present a
damage breakdown (PoB's own is a multi-stage pipeline: base → added →
conversion → more/inc → crit → ailments). This is real engineering, not a
wrapper. PoB's `CalcBreakdown.lua` tables may be a better source than
re-deriving via `Tabulate`. Scope carefully before starting.

### Minor: resolve cluster/ascendancy node names in `get_stat_breakdown`

A few breakdown sources render as `Passive node 65696` instead of a name —
node IDs the tree-data loader doesn't resolve (cluster-jewel-generated nodes,
some ascendancy nodes). Low priority; graceful fallback is already in place.
Fix would teach the source-humanizer to consult live PoB (`get_node_state`) for
IDs missing from `tree.lua`.

---

## Playbook wishlist

Tracked in [`../playbooks/README.md`](../playbooks/README.md) §7. Currently unwritten:

- `crafting-decisions.md` — now that the crafting tools exist (see below), a
  playbook tying them together: target mod set → method choice → odds → cost
  reasoning.
- `defense-audit.md` — EHP layers, recovery, ailment immunity coverage.
- `league-start-character-pick.md` — annual workflow: guides + class meta +
  early-league economy.

Each should get a thin wrapper skill in `.claude/skills/` when written (see the
skills/playbooks layering in the suite-root `CLAUDE.md`).

---

## Deliberately NOT doing (and why)

### Full game-data extraction pipeline (`pathofexile-dat` + Oodle)

**Decision: abandoned / superseded.** The original plan extracted `data.json`,
Timeless-Jewel transformation tables, and stat-description templates directly
from the user's local PoE install via `pathofexile-dat`, then rendered
transformed node tooltips ourselves (including porting PoB's `StatDesc.lua`
template engine).

**Why we didn't:** we hit the actual goal — "no more tooltip pastes for
Timeless-Jewel-transformed nodes" — far more cheaply by having **PoB read its
own already-computed, post-transformation `node.sd`** via the `get_node_state`
Lua action (which powers `get_tree_node_with_timeless_jewels`). That sidesteps:
- the Oodle DLL dependency,
- `.datc64` schema-drift maintenance,
- PSG binary parsing (PoB community itself abandoned `psg.lua`),
- reimplementing the stat-description template renderer (the single hardest
  piece), and
- the legal tightrope of extracting/redistributing creative game data (see the
  skilltree fork's `legal_considerations.md`).

The proof-of-concept in `data-extraction-poc/` (gitignored) proved the
extraction *works*, but it's strictly more complex and more fragile than
reading what PoB already computed. Keep it only as a last-resort fallback if
PoB ever stops shipping the data we need.

### Crafting "deep" probability / cost engine (fossils, harvest, meta-crafts, currency EV)

**Decision: out of scope — point users at Craft of Exile.** The suite now
covers the *reference and identification* layer of crafting, plus **exact
roll-pool odds** for the common cases:
- `search_crafting_mods`, `list_craftable_mods_for_base` — what can roll
- `analyze_item_mods` — identify an item's mods + tiers + next-tier
- `search_master_crafts`, `get_essence_detail` — bench crafts, essences
- `calculate_mod_odds` — exact weighted without-replacement odds for
  chaos/alt/essence, from the game's real spawn weights

What we deliberately stop short of: fossil/resonator weight biasing, harvest
reforge-with-tag, meta-craft sequences ("prefixes cannot be changed" chains),
per-orb affix-count variance, and full expected-currency-cost EV.

**Why:** that depth is Craft of Exile's entire value proposition, built and
maintained over years against constantly-shifting weights. Replicating it would
be a large, perpetually-stale effort for marginal gain. Our niche is the
*authoritative-data* layer (weights straight from the game via PoB) plus the
"what are my odds on this base" question — not a full crafting simulator.
`calculate_mod_odds` states this boundary in its own output. (No public API or
MCP for CoE exists as of this writing; scraping its client-side data was
considered and rejected as brittle and duplicative.)

### Atlas completion / map-progress data

**Decision: not feasible.** GGG's public API does not expose Atlas map
completion or bonus-objective progress. Multiple endpoints were investigated;
there's no authoritative source short of screen-scraping the client. The atlas
*tree* tools (`get_atlas_node`, `search_atlas_nodes`, `find_atlas_path_to_node`)
cover the data we can get.

---

## Shipped (record of completed roadmap, so the pivots aren't re-litigated)

These were once "future work" here and are now live:

- **Passive tree per-node data** from PoB's `tree.lua` (`pobTreeDataLoader.ts`)
  + GGG `data.json` fallback. Pivot: parse PoB's `tree.lua` rather than extract
  & render from game bundles.
- **Skilltree patches overlay** tools: `get_tree_node`,
  `report_tree_node_discrepancy`, `list_tree_patches`, `get_tree_node_patch`.
- **Full jewel-awareness suite**: `find_jewel_affected_nodes`,
  `get_tree_node_with_timeless_jewels`, `evaluate_threshold_jewels`,
  `list_cluster_jewel_nodes`, `list_radius_effect_jewels`, on shared
  `radiusUtils.ts`.
- **Atlas tree** read tools: `get_atlas_node`, `search_atlas_nodes`,
  `find_atlas_path_to_node`.
- **Any-node-to-any-node routing**: `from_node_id` on `find_path_to_node`.
- **Crafting toolkit**: `search_crafting_mods`, `list_craftable_mods_for_base`,
  `analyze_item_mods`, `search_master_crafts`, `get_essence_detail`,
  `calculate_mod_odds`.
- **`get_stat_breakdown`**: modifier source attribution via a new
  `get_stat_breakdown` Lua action (see the open item for its damage-stat limit).
- **League-aware defaults** + `get_active_leagues`; `playbooks/league-transition.md`.
