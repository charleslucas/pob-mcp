/**
 * Handlers for the patches-overlay MCP tools:
 *   report_tree_node_discrepancy — add/update a patch entry
 *   list_tree_patches            — audit existing patches
 *
 * Backed by skilltreePatchesService.ts. Writes to the skilltree fork's
 * data_patches.json on disk (under reference_data/skilltree/). Anyone wanting
 * to share corrections with the broader community still needs to commit and
 * push the fork submodule — these handlers only write to disk locally.
 */

import {
  upsertPatch,
  removePatch,
  listPatchesSummary,
  getPatch,
  type PatchOperation,
  type PatchSource,
} from "../services/skilltreePatchesService.js";

const VALID_OPERATIONS: PatchOperation[] = [
  "stats_add",
  "stats_replace",
  "name_replace",
  "flags_set",
];

const VALID_SOURCES: PatchSource[] = [
  "in-game tooltip",
  "PoB tree data",
  "PoB lua_get_passive_detail",
  "wiki",
  "reddit/forum",
];

export async function handleReportTreeNodeDiscrepancy(
  nodeId: string,
  operation: string,
  value: unknown,
  verifiedFrom: string,
  verifiedBy: string,
  note?: string
) {
  if (!nodeId) {
    return {
      content: [{ type: "text", text: "Error: node_id is required." }],
      isError: true,
    };
  }
  if (!VALID_OPERATIONS.includes(operation as PatchOperation)) {
    return {
      content: [
        {
          type: "text",
          text: `Error: operation must be one of: ${VALID_OPERATIONS.join(", ")}. Got: ${operation}`,
        },
      ],
      isError: true,
    };
  }
  if (!VALID_SOURCES.includes(verifiedFrom as PatchSource)) {
    return {
      content: [
        {
          type: "text",
          text: `Error: verified_from must be one of: ${VALID_SOURCES.join(" | ")}. Got: ${verifiedFrom}`,
        },
      ],
      isError: true,
    };
  }
  if (!verifiedBy) {
    return {
      content: [
        {
          type: "text",
          text: 'Error: verified_by is required (e.g., "AccountName#1234" or "Claude").',
        },
      ],
      isError: true,
    };
  }

  let result;
  try {
    result = upsertPatch({
      nodeId,
      operation: operation as PatchOperation,
      value: value as string | string[] | Record<string, boolean | string | null>,
      verified_from: verifiedFrom as PatchSource,
      verified_by: verifiedBy,
      note,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error writing patch: ${msg}` }],
      isError: true,
    };
  }

  const lines: string[] = [];
  lines.push(`✓ Patch ${result.action} for node ${nodeId}`);
  lines.push(`  File: ${result.path}`);
  lines.push("");
  lines.push("New entry:");
  lines.push(JSON.stringify({ [nodeId]: result.entry }, null, 2));
  if (result.previous) {
    lines.push("");
    lines.push("Previous entry (replaced):");
    lines.push(JSON.stringify({ [nodeId]: result.previous }, null, 2));
  }
  lines.push("");
  lines.push("⚠️  REMINDER: this only writes to disk locally. To share the");
  lines.push("correction with the broader community, commit and push the");
  lines.push("skilltree fork:");
  lines.push("  cd reference_data/skilltree && git add data_patches.json \\");
  lines.push("    && git commit -m 'patch: <node N> — <reason>' && git push");
  lines.push("");
  lines.push("Before committing, verify the patch is correct per the rules in");
  lines.push("reference_data/skilltree/PATCHES.md — notably, that the node is");
  lines.push("NOT being transformed by a Timeless Jewel (blank-line tooltip test).");

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

export async function handleListTreePatches(filterSource?: string, minAgeDays?: number) {
  let summaries;
  try {
    summaries = listPatchesSummary();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error reading patches: ${msg}` }],
      isError: true,
    };
  }

  // Filters
  if (filterSource) {
    summaries = summaries.filter((s) => s.verified_from === filterSource);
  }
  if (typeof minAgeDays === "number" && minAgeDays >= 0) {
    summaries = summaries.filter((s) => s.age_days >= minAgeDays);
  }

  if (summaries.length === 0) {
    return {
      content: [
        {
          type: "text",
          text:
            "No patches in `reference_data/skilltree/data_patches.json`" +
            (filterSource || minAgeDays !== undefined ? " matching the filters." : "."),
        },
      ],
    };
  }

  const lines: string[] = [];
  lines.push(`=== Skilltree patches (${summaries.length} entr${summaries.length === 1 ? "y" : "ies"}) ===`);
  lines.push("");
  for (const s of summaries) {
    lines.push(
      `Node ${s.nodeId}: [${s.operations.join(", ")}]  ` +
        `${s.verified_date} (${s.age_days}d ago)  ` +
        `from ${s.verified_from}  by ${s.verified_by}`
    );
    if (s.note) lines.push(`  note: ${s.note}`);
  }
  lines.push("");
  lines.push("Stale patches (verified before the current GGG tree export was");
  lines.push("released) are candidates for re-verification or retirement. The");
  lines.push("upstream merge protocol is documented in the fork's PATCHES.md.");

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// Also expose a read-only "get the current patch for one node" — useful for
// Claude to check whether an entry already exists before calling upsert.
export async function handleGetTreeNodePatch(nodeId: string) {
  if (!nodeId) {
    return {
      content: [{ type: "text", text: "Error: node_id is required." }],
      isError: true,
    };
  }
  const entry = getPatch(nodeId);
  if (!entry) {
    return {
      content: [{ type: "text", text: `No patch entry for node ${nodeId}.` }],
    };
  }
  return {
    content: [
      {
        type: "text",
        text:
          `Current patch for node ${nodeId}:\n` +
          JSON.stringify({ [nodeId]: entry }, null, 2),
      },
    ],
  };
}

// Exposed but only for documentation; we don't wire a tool for removePatch
// because retiring a patch is a deliberate action that should go through the
// fork's merge-policy review (see PATCHES.md). Importing here keeps the API
// surface symmetric.
export { removePatch };
