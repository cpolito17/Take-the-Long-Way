// De-duplication across sources (spec §4). Mirrors backend/app/dedupe.py:
// entries from different sources that are the same physical place — close
// coordinates + similar names — are merged, not shown twice.

import type { Place } from "./types";
import { crossSourceBoost } from "./scoring";

const GRID_DEG = 0.005; // ~0.35 mi of latitude per cell
const NAME_SIM_THRESHOLD = 0.62;

const STOPWORDS = /\b(the|of|and|a|an|at|in|on|historic|historical|site|marker|monument|museum)\b/g;
const NON_ALNUM = /[^a-z0-9 ]+/g;

export function normName(name: string): string {
  const s = name.toLowerCase().replace(NON_ALNUM, " ").replace(STOPWORDS, " ");
  return s.split(/\s+/).filter(Boolean).join(" ");
}

// Similarity in the spirit of difflib.SequenceMatcher.ratio():
// 2 * LCS(a, b) / (|a| + |b|). Names are short, so the O(n·m) DP is cheap.
function lcsLength(a: string, b: string): number {
  const m = a.length, n = b.length;
  let prev = new Array<number>(n + 1).fill(0);
  let cur = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

function similar(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  return (2 * lcsLength(a, b)) / (a.length + b.length) >= NAME_SIM_THRESHOLD;
}

function cellOf(p: Place): [number, number] {
  return [Math.floor(p.lat / GRID_DEG), Math.floor(p.lng / GRID_DEG)];
}

// Fold `other` into `primary` (assumed the higher-scoring of the two),
// filling gaps and recording the extra source.
export function mergeInto(primary: Place, other: Place): Place {
  if (!primary.description && other.description) primary.description = other.description;
  if (!primary.image_url && other.image_url) primary.image_url = other.image_url;
  if (!primary.source_url && other.source_url) primary.source_url = other.source_url;
  primary.tags = [...new Set([...primary.tags, ...other.tags])];
  const mergedSources = [...new Set([...primary.sources, ...other.sources])];
  primary.sources = mergedSources;
  primary.score = crossSourceBoost(Math.max(primary.score, other.score), mergedSources.length);
  return primary;
}

// Merge same-physical-place records: same/adjacent ~0.35 mi grid cell and
// similar normalized names. Highest score wins identity.
export function dedupe(places: Place[]): Place[] {
  const sorted = [...places].sort((a, b) => b.score - a.score);
  const grid = new Map<string, [string, Place][]>();
  const kept: Place[] = [];

  for (const p of sorted) {
    const [ci, cj] = cellOf(p);
    const pname = normName(p.name);
    let winner: Place | null = null;
    outer:
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (const [kname, kp] of grid.get(`${ci + di},${cj + dj}`) ?? []) {
          if (kp.source !== p.source && similar(pname, kname)) {
            winner = kp;
            break outer;
          }
        }
      }
    }
    if (winner !== null) {
      mergeInto(winner, p);
    } else {
      if (!p.sources.length) p.sources = [p.source];
      kept.push(p);
      const key = `${ci},${cj}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key)!.push([pname, p]);
    }
  }
  return kept;
}
