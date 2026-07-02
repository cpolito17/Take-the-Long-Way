// Scoring (spec §5): 0–100 per place. Mirrors backend/app/scoring.py.

function log10p(x: number): number {
  return Math.log10(1.0 + Math.max(0.0, x));
}

export function clamp(score: number): number {
  return Math.round(Math.max(0.0, Math.min(100.0, score)) * 10) / 10;
}

export function wikipedia(views60d: number): number {
  return clamp(24 + 13 * log10p(views60d / 2.0));
}

export function osm(numTags: number, hasWikipedia: boolean): number {
  return clamp(20 + 2.5 * Math.min(numTags, 10) + (hasWikipedia ? 18 : 0));
}

export function universalBoosts(score: number, hasImage: boolean, description: string): number {
  if (hasImage) score += 5;
  if ((description || "").length >= 80) score += 5;
  return clamp(score);
}

export function crossSourceBoost(score: number, nSources: number): number {
  return clamp(score + 9 * (nSources - 1));
}
