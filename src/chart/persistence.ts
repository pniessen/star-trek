import { CAMPAIGN_VERSION, newCampaign, type Campaign } from "./campaign.js";
import { SECTOR_COUNT } from "./sectors.js";

export const SAVE_KEY = "kobayashi.campaign";

/**
 * Injected rather than reaching for localStorage, so the campaign rules stay
 * testable in bare node and the chart modules stay free of the DOM.
 */
export interface CampaignStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function save(campaign: Campaign, storage: CampaignStorage): void {
  storage.setItem(SAVE_KEY, JSON.stringify(campaign));
}

/**
 * Never throws. A player whose save is corrupt, absent, or written by a newer
 * build gets a fresh campaign — a black screen is a worse outcome than a lost
 * campaign, and we do not fight save-scumming anyway.
 */
export function load(storage: CampaignStorage, freshSeed: number): Campaign {
  const raw = storage.getItem(SAVE_KEY);
  if (raw === null) return newCampaign(freshSeed);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return newCampaign(freshSeed);
  }

  if (!isCampaign(parsed) || parsed.version !== CAMPAIGN_VERSION) {
    return newCampaign(freshSeed);
  }
  return parsed;
}

/**
 * Every field checked here is one `spawnWave()` dereferences without a guard
 * of its own — `campaign.sectors[campaign.current].threat`, chiefly — inside
 * `frame()`, before `requestAnimationFrame` re-arms. A save that passes this
 * check but is still short a field throws there instead, and the loop never
 * restarts: the game freezes on the last frame rather than falling back to a
 * fresh campaign, which is the one outcome this module exists to prevent.
 */
function isCampaign(value: unknown): value is Campaign {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Partial<Campaign>;
  return (
    typeof c.version === "number" &&
    typeof c.seed === "number" &&
    typeof c.rngCursor === "number" &&
    typeof c.salvage === "number" &&
    typeof c.front === "number" &&
    typeof c.current === "number" &&
    Array.isArray(c.sectors) &&
    c.sectors.length === SECTOR_COUNT &&
    Array.isArray(c.incoming)
  );
}
