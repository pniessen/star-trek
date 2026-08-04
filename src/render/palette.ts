import { Color } from "three";

/**
 * Colour is information, not decoration — decided up front so the roster never
 * drifts into "everything is cyan". Hull cyan, hostiles amber, the unknown
 * magenta, structure dim.
 */
export const PALETTE = {
  void: new Color(0x04070b),
  // Cyan is *ours*, not merely the player's — the Warden flies in it too, and
  // deliberately gets no hue of its own. A sixth colour would say "another
  // class" when the only thing that needs saying about an ally is "not a
  // target", and there is no gap on the wheel that is clear of five hostile
  // hues and still reads as friendly. Silhouette tells the two apart; see
  // `buildWarden` and `allies.ts`.
  trace: new Color(0x56e7e0), // friendly hulls: the player, and the Warden
  traceDim: new Color(0x2c8f92), // structure, grid, distant detail
  amber: new Color(0xf2a63b), // alerts, and the raider class

  // Hostile classes get their own hue as well as their own outline. Silhouette
  // carries at range; colour carries when three of them overlap in a brawl.
  // All are kept well clear of the player's cyan.
  raider: new Color(0xf2a63b), // gold — fast, common
  lance: new Color(0xa8dc4a), // acid green — the long-range one
  bastion: new Color(0xe8563c), // red-orange — the heavy
  // Violet sits in the widest gap left on the wheel — 75° clear of both the
  // player's cyan and the magenta unresolved return — so the mine-layer and
  // the hazards it leaves behind can never be mistaken for either.
  harrow: new Color(0x9a6cf0), // violet — the mine-layer, and its mines
  magenta: new Color(0xe45fa0), // unresolved contacts, anomalies, the cloaker
  star: new Color(0x7fb6bd),
} as const;
