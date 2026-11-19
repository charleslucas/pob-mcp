/**
 * One answer to "how much damage does this build do?" for reports.
 *
 * Minion and multi-skill builds can read 0 in the player's DPS fields, and the main
 * skill alone misses every other flagged group, so the Full DPS roll-up wins whenever
 * the player's own skill is the minority of it.
 */
export const BUILD_DPS_FIELDS = [
  'TotalDPS', 'CombinedDPS', 'MinionTotalDPS', 'MinionCombinedDPS', 'FullDPS',
];

export interface BuildDps {
  value: number;
  label: 'DPS' | 'Minion DPS' | 'Full DPS';
}

export function resolveBuildDps(stats: Record<string, any> | null | undefined): BuildDps {
  const s = stats ?? {};
  const player = Number(s.CombinedDPS) || Number(s.TotalDPS) || 0;
  const minion = Number(s.MinionCombinedDPS) || Number(s.MinionTotalDPS) || 0;
  const full = Number(s.FullDPS) || 0;
  if (full > 0 && player < full * 0.5) return { value: full, label: 'Full DPS' };
  if (minion > player) return { value: minion, label: 'Minion DPS' };
  return { value: player, label: 'DPS' };
}
