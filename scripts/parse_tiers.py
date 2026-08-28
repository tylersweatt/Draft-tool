#!/usr/bin/env python3
"""
Parse a SB Nation PPR tier sheet PDF into structured tiers.

The sheet lays six positional columns side by side, so flowed text extraction
interleaves them and picks up the rotated "SBNATION DRAFTING TIERS" letters
running down the margin. This reads glyph coordinates instead and assigns each
line to a column by its x position.

Run:  python3 scripts/parse_tiers.py <sheet.pdf>
Out:  data/expert_tiers.json
"""

import json
import os
import re
import sys
from collections import defaultdict

from pdfminer.high_level import extract_pages
from pdfminer.layout import LTTextContainer, LTTextLine

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, os.pardir, "data", "expert_tiers.json")

# Column centers measured off the sheet, in PDF points.
COLUMNS = [
    ("QB", 100), ("RB", 178), ("WR", 258), ("TE", 342), ("DST", 410), ("K", 500),
]
MARGIN_X = 70          # rotated title letters sit left of every real column
COLUMN_TOLERANCE = 42

HEADER_WORDS = {
    "ppr", "quarterbacks", "running backs", "wide receivers", "tight ends",
    "defenses", "kickers", "28-aug", "stream d/st",
}
TIER_RE = re.compile(r"^tier\s*(\d+)$", re.I)


def column_for(x):
    best, best_d = None, None
    for name, cx in COLUMNS:
        d = abs(x - cx)
        if best_d is None or d < best_d:
            best, best_d = name, d
    return best if best_d is not None and best_d <= COLUMN_TOLERANCE else None


def main():
    if len(sys.argv) < 2:
        print("usage: parse_tiers.py <sheet.pdf>", file=sys.stderr)
        return 2
    pdf = sys.argv[1]

    # (page, -y, x) -> text, so a sort walks each page top to bottom.
    lines = []
    for pno, layout in enumerate(extract_pages(pdf)):
        for el in layout:
            if not isinstance(el, LTTextContainer):
                continue
            for line in el:
                if not isinstance(line, LTTextLine):
                    continue
                text = line.get_text().strip()
                if not text or line.x0 < MARGIN_X:
                    continue
                col = column_for(line.x0)
                if col:
                    lines.append((pno, -line.y1, line.x0, col, text))
    lines.sort()

    tiers = defaultdict(dict)
    current = {name: None for name, _ in COLUMNS}
    order = defaultdict(int)

    for _, _, _, col, text in lines:
        low = text.lower()
        if low in HEADER_WORDS or len(text) <= 1:
            # "Stream D/ST" is a directive, not a tier, so defenses stay tierless.
            continue
        m = TIER_RE.match(text)
        if m:
            current[col] = int(m.group(1))
            continue
        if current[col] is None:
            continue
        name = re.sub(r"\s+", " ", text).strip()
        if name and name not in tiers[col]:
            order[col] += 1
            tiers[col][name] = {"tier": current[col], "order": order[col]}

    payload = {
        "source": "SB Nation PPR tiers",
        "scoring": "Full PPR",
        "file": os.path.basename(pdf),
        "positions": {k: v for k, v in tiers.items()},
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(payload, f, indent=1, sort_keys=True)

    for pos, players in sorted(tiers.items()):
        maxt = max(v["tier"] for v in players.values())
        print(f"  {pos:>3}: {len(players):>3} players, {maxt} tiers", file=sys.stderr)
    print(f"Wrote {os.path.relpath(OUT)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
