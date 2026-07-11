/**
 * Parse the "Sockets:" line from a Path of Building item's raw text.
 *
 * PoB serialises sockets as e.g. `Sockets: R-G-B G-G` (see Classes/Item.lua):
 * each character is a colour (R/G/B/W = red/green/blue/white for str/dex/int/
 * generic, A = abyssal); sockets joined by "-" are linked (same group); a space
 * separates link groups. PoB reads the actual colours on import, so this is the
 * real socket layout of the item — not the "assume it's chromable" abstraction.
 */

export type SocketColor = "R" | "G" | "B" | "W" | "A";

export interface ItemSockets {
  /** The socket string as PoB stores it, e.g. "R-G-B G-G". */
  raw: string;
  /** Linked groups, e.g. [["R","G","B"],["G","G"]]. */
  groups: SocketColor[][];
  /** Total socket count. */
  total: number;
  /** Size of the largest linked group (the "N-link"). */
  maxLink: number;
  /** Count per colour (only colours present are guaranteed non-zero). */
  colorCounts: Record<SocketColor, number>;
  /** Number of abyssal ("A") sockets. */
  abyssal: number;
}

const COLOR_NAMES: Record<SocketColor, string> = {
  R: "Red",
  G: "Green",
  B: "Blue",
  W: "White",
  A: "Abyssal",
};

export function socketColorName(c: string): string {
  return COLOR_NAMES[c as SocketColor] ?? c;
}

const VALID_COLORS = new Set<SocketColor>(["R", "G", "B", "W", "A"]);

/**
 * Returns parsed socket info, or `null` if the item has no "Sockets:" line
 * (e.g. most amulets/rings/belts, or a zero-socket base).
 */
export function parseItemSockets(raw: string | undefined | null): ItemSockets | null {
  if (!raw) return null;
  const match = raw.match(/^Sockets:\s*(.+?)\s*$/m);
  if (!match) return null;

  const socketStr = match[1].trim();
  if (!socketStr) return null;

  const groups: SocketColor[][] = [];
  const colorCounts: Record<SocketColor, number> = { R: 0, G: 0, B: 0, W: 0, A: 0 };
  let total = 0;
  let abyssal = 0;

  for (const groupStr of socketStr.split(/\s+/)) {
    const group: SocketColor[] = [];
    for (const ch of groupStr.split("-")) {
      const c = ch.trim().toUpperCase();
      if (!c) continue;
      const color = (VALID_COLORS.has(c as SocketColor) ? c : "W") as SocketColor;
      group.push(color);
      colorCounts[color] += 1;
      total += 1;
      if (color === "A") abyssal += 1;
    }
    if (group.length > 0) groups.push(group);
  }

  if (total === 0) return null;

  const maxLink = groups.reduce((mx, g) => Math.max(mx, g.length), 0);
  return { raw: socketStr, groups, total, maxLink, colorCounts, abyssal };
}
