/**
 * Handler for the get_calc_breakdown MCP tool.
 *
 * Surfaces PoB's OWN computed breakdown for an output stat — the multiplier
 * chain shown on the Calcs tab (base -> added -> conversion -> increased ->
 * more -> crit -> ailment -> total). This is the "why is my damage / stat
 * this number" view, straight from PoB's calc engine. We don't re-derive any
 * math: PoB already built the breakdown in its CALCS-mode env; the Lua action
 * just flattens its display structure to text lines and we relay them.
 *
 * Complements get_stat_breakdown: this gives the *pipeline* (which bucket is
 * weak); get_stat_breakdown (esp. with use_skill_config) gives *source
 * attribution* (where a bucket's value comes from).
 *
 * Pass no `stat` (or an unknown one) to get the list of stats that currently
 * have a breakdown for the open build.
 */

import type { AnyLuaClient } from "../pobLuaBridge.js";

export interface CalcBreakdownContext {
  getLuaClient: () => AnyLuaClient | null;
  ensureLuaClient: () => Promise<void>;
}

export interface CalcBreakdownArgs {
  stat?: string;
  actor?: "player" | "minion";
  raw_json?: boolean;
}

interface CalcBreakdownResult {
  stat?: string;
  found?: boolean;
  actor?: string;
  output_value?: number | null;
  lines?: string[];
  available?: string[];
}

export async function handleGetCalcBreakdown(
  context: CalcBreakdownContext,
  args: CalcBreakdownArgs
) {
  try {
    await context.ensureLuaClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text",
          text: `Error connecting to PoB: ${msg}\nThis tool needs a live PoB build — launch via LaunchPoBWithAPI.bat, then retry.`,
        },
      ],
      isError: true,
    };
  }

  const client = context.getLuaClient();
  if (!client) {
    return {
      content: [{ type: "text", text: "Error: PoB Lua client not initialized." }],
      isError: true,
    };
  }

  let result: CalcBreakdownResult;
  try {
    result = (await client.getCalcBreakdown({ stat: args.stat, actor: args.actor })) as CalcBreakdownResult;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error reading calc breakdown: ${msg}` }],
      isError: true,
    };
  }

  if (args.raw_json) {
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }

  // No stat requested, or stat not found → show the available list.
  if (!args.stat || result.found === false || (!result.lines && result.available)) {
    const avail = result.available ?? [];
    const lines: string[] = [];
    if (args.stat && result.found === false) {
      lines.push(`No breakdown found for "${args.stat}" on the current build.`);
      lines.push("");
    }
    lines.push(`Stats with a breakdown available right now (${avail.length}):`);
    // chunk into readable rows
    const perRow = 4;
    for (let i = 0; i < avail.length; i += perRow) {
      lines.push("  " + avail.slice(i, i + perRow).join(", "));
    }
    lines.push("");
    lines.push(
      "Call get_calc_breakdown with one of these as `stat` to see PoB's full " +
        "multiplier chain. (Damage breakdowns appear once the build has a valid " +
        "main skill with an enemy configured.)"
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  const lines: string[] = [];
  lines.push(`=== PoB calc breakdown: ${result.stat} (${result.actor ?? "player"}) ===`);
  if (result.output_value !== undefined && result.output_value !== null) {
    lines.push(`Output value: ${result.output_value}`);
  }
  lines.push("");
  const body = result.lines ?? [];
  if (body.length === 0) {
    lines.push("(PoB returned an empty breakdown for this stat — it may be a");
    lines.push("simple passthrough value with no multiplier chain to show.)");
  } else {
    for (const l of body) lines.push(l);
  }
  lines.push("");
  lines.push(
    "Source: PoB's own Calcs-tab breakdown (CALCS env), relayed verbatim — no " +
      "math re-derived here. For where a given bucket's value comes from " +
      "(which passives/items), use get_stat_breakdown with use_skill_config."
  );
  return { content: [{ type: "text", text: lines.join("\n") }] };
}
