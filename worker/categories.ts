// Maps source tags/types to TTLW categories. Mirrors backend/app/categories.py.

// Checked in order — first match wins, so put the most specific first.
const KEYWORD_CATEGORY: [string, string[]][] = [
  ["Event", ["earthquake", "massacre", "riot", "aviation accident", "plane crash",
    "train wreck", "rail accident", "mining disaster", "explosion of",
    "fire of 1", "fire of 2", "flood of", "tornado outbreak", "hurricane",
    "landslide", "avalanche", "disaster", "bombing", "duel ", "wildfire",
    "terrorist attack", "mass shooting", "battle of"]],
  ["Ruins", ["ruins", "abandoned", "ghost town", "ghost-town", "derelict", "wreck",
    "shipwreck", "decay"]],
  ["Roadside", ["roadside", "world's largest", "worlds largest", "muffler man",
    "giant", "novelty architecture", "big things", "drive-in",
    "neon", "route 66", "diner", "gas station"]],
  ["Art", ["art", "sculpture", "mural", "statue", "artwork", "mosaic",
    "installation", "folk art", "land art"]],
  ["Weird", ["weird", "odd", "unusual", "strange", "mystery", "paranormal",
    "ufo", "cryptid", "bizarre", "curiosities", "oddities", "occult",
    "creepy", "haunted"]],
  ["Natural", ["nature", "natural", "geology", "geological", "cave", "caves",
    "spring", "waterfall", "canyon", "rock formation", "fossil",
    "tree", "forest", "dunes", "crater", "hot spring"]],
  ["Community", ["community", "festival", "museum", "library", "market",
    "church", "temple", "cemetery", "graveyard", "memorial"]],
  ["Historical", ["history", "historical", "historic", "heritage", "battle",
    "fort", "war", "archaeology", "monument", "marker", "mine",
    "railroad", "lighthouse", "bridge"]],
];

export function categorize(tags: string[], name = "", description = ""): string {
  const haystacks = [...tags.map((t) => t.toLowerCase()), name.toLowerCase(), (description || "").toLowerCase()];
  for (const [category, keywords] of KEYWORD_CATEGORY) {
    for (const kw of keywords) {
      for (const h of haystacks) {
        if (h.includes(kw)) return category;
      }
    }
  }
  return "Other";
}
