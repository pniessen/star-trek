import { Color } from "three";

/**
 * Colour is information, not decoration — decided up front so the roster never
 * drifts into "everything is cyan". Hull cyan, hostiles amber, the unknown
 * magenta, structure dim.
 */
export const PALETTE = {
  void: new Color(0x04070b),
  trace: new Color(0x56e7e0), // friendly hull, player
  traceDim: new Color(0x2c8f92), // structure, grid, distant detail
  amber: new Color(0xf2a63b), // hostiles, alerts
  magenta: new Color(0xe45fa0), // unresolved contacts, anomalies
  star: new Color(0x7fb6bd),
} as const;
