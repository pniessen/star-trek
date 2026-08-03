import { CAMPAIGN_VERSION, newCampaign, type Campaign } from "./campaign.js";

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

function isCampaign(value: unknown): value is Campaign {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Partial<Campaign>;
  return (
    typeof c.version === "number" &&
    typeof c.seed === "number" &&
    typeof c.rngCursor === "number" &&
    typeof c.salvage === "number" &&
    typeof c.front === "number" &&
    Array.isArray(c.sectors)
  );
}
