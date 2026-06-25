"""Single place that maps source tags/types to TTLW categories.
Categories: Roadside / Historical / Natural / Art / Weird / Ruins /
Community / Other (spec §4)."""

# Checked in order — first match wins, so put the most specific first.
KEYWORD_CATEGORY: list[tuple[str, list[str]]] = [
    # Things that happened here (vs. places that still stand) — lets users
    # filter historical events apart from currently visitable sites.
    ("Event", ["earthquake", "massacre", "riot", "aviation accident", "plane crash",
               "train wreck", "rail accident", "mining disaster", "explosion of",
               "fire of 1", "fire of 2", "flood of", "tornado outbreak", "hurricane",
               "landslide", "avalanche", "disaster", "bombing", "duel ", "wildfire",
               "terrorist attack", "mass shooting", "battle of"]),
    ("Ruins", ["ruins", "abandoned", "ghost town", "ghost-town", "derelict", "wreck",
               "shipwreck", "decay"]),
    ("Roadside", ["roadside", "world's largest", "worlds largest", "muffler man",
                  "giant", "novelty architecture", "big things", "drive-in",
                  "neon", "route 66", "diner", "gas station"]),
    ("Art", ["art", "sculpture", "mural", "statue", "artwork", "mosaic",
             "installation", "folk art", "land art"]),
    ("Weird", ["weird", "odd", "unusual", "strange", "mystery", "paranormal",
               "ufo", "cryptid", "bizarre", "curiosities", "oddities", "occult",
               "creepy", "haunted"]),
    ("Natural", ["nature", "natural", "geology", "geological", "cave", "caves",
                 "spring", "waterfall", "canyon", "rock formation", "fossil",
                 "tree", "forest", "dunes", "crater", "hot spring"]),
    ("Community", ["community", "festival", "museum", "library", "market",
                   "church", "temple", "cemetery", "graveyard", "memorial"]),
    ("Historical", ["history", "historical", "historic", "heritage", "battle",
                    "fort", "war", "archaeology", "monument", "marker", "mine",
                    "railroad", "lighthouse", "bridge"]),
]


def categorize(tags: list[str], name: str = "", description: str = "") -> str:
    haystacks = [t.lower() for t in tags] + [name.lower(), (description or "").lower()]
    for category, keywords in KEYWORD_CATEGORY:
        for kw in keywords:
            for h in haystacks:
                if kw in h:
                    return category
    return "Other"
