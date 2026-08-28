#!/usr/bin/env python3
"""
Build the offline player dataset for the draft tool.

Pulls live sources, joins them, models Full-PPR point projections, assigns
tiers, and writes a single self-contained JSON that the draft board reads.

Sources
  - FantasyPros consensus ECR, scraped daily by DynastyProcess
  - DynastyProcess player values (carries 1QB vs superflex ECR)
  - nflverse schedule, used to derive true bye weeks from the real 2026 slate

Run:  python3 scripts/build_data.py
"""

import csv
import io
import json
import math
import os
import re
import sys
import urllib.request
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, os.pardir, "data", "players.json")
OUT_JS = os.path.join(HERE, os.pardir, "data", "players.js")

ECR_URL = "https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_fpecr_latest.csv"
VALUES_URL = "https://raw.githubusercontent.com/dynastyprocess/data/master/files/values-players.csv"
GAMES_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv"

SEASON = 2026

# FantasyPros team codes -> nflverse team codes
TEAM_FIX = {
    "GBP": "GB", "JAC": "JAX", "KCC": "KC", "LVR": "LV",
    "NEP": "NE", "NOS": "NO", "SFO": "SF", "TBB": "TB",
}

POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"]

# Expected Full-PPR season totals by positional rank. Preseason projections are
# expected values, not ceilings, so these sit below what a league winner posts.
# Anchors are interpolated linearly and decay exponentially past the last one.
POINT_CURVES = {
    # Baseline assumes 4 points per passing touchdown. build_qb_curve() rebuilds
    # this for leagues that pay 6.
    "QB":  [(1, 395), (2, 375), (3, 358), (4, 345), (6, 325), (8, 308),
            (10, 292), (12, 278), (15, 258), (18, 240), (24, 210), (32, 175), (40, 150)],
    "RB":  [(1, 340), (2, 315), (3, 298), (4, 285), (5, 272), (6, 262), (8, 243),
            (10, 228), (12, 215), (15, 196), (18, 180), (24, 155), (30, 135),
            (36, 118), (48, 92), (60, 72)],
    "WR":  [(1, 335), (2, 315), (3, 300), (4, 288), (5, 278), (6, 268), (8, 252),
            (10, 238), (12, 226), (15, 210), (18, 196), (24, 172), (30, 153),
            (36, 137), (48, 110), (60, 90), (80, 65)],
    "TE":  [(1, 265), (2, 230), (3, 210), (4, 196), (5, 185), (6, 175), (8, 158),
            (10, 145), (12, 134), (15, 120), (18, 108), (24, 88), (30, 72)],
    "K":   [(1, 150), (6, 136), (12, 124), (18, 112), (24, 100)],
    "DST": [(1, 145), (6, 120), (12, 104), (18, 90), (24, 78)],
}

# Target average tier size, per position. Tier count is derived from this so
# tiers stay small enough to be actionable ("two left in this tier").
TIER_SIZE = {"QB": 4, "RB": 5, "WR": 5, "TE": 4, "K": 6, "DST": 6}


# Passing touchdowns thrown per season by the Nth-best fantasy QB. A six-point
# passing TD is worth about 60 extra points to an elite QB and only about 24 to
# a streamer, so it widens the gap between QBs rather than lifting them evenly —
# which is what actually moves them up draft boards.
QB_PASS_TDS = {
    1: 30, 2: 29, 3: 28, 4: 27, 6: 26, 8: 25, 10: 24,
    12: 23, 15: 21, 18: 20, 24: 17, 32: 14, 40: 12,
}


def build_qb_curve(pass_td_value):
    """Rescale the QB curve for a league's passing-touchdown value."""
    delta = pass_td_value - 4
    return [
        (rank, pts + delta * QB_PASS_TDS.get(rank, 12))
        for rank, pts in POINT_CURVES["QB"]
    ]


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "draft-tool/1.0"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return r.read().decode("utf-8", errors="replace")


def read_csv(text):
    return list(csv.DictReader(io.StringIO(text)))


def num(v, default=None):
    try:
        if v in ("", "NA", None):
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def project(pos, rank):
    """Expected Full-PPR season points for the Nth-best player at a position."""
    curve = POINT_CURVES.get(pos)
    if not curve or rank is None:
        return 0.0
    if rank <= curve[0][0]:
        return float(curve[0][1])
    for i in range(len(curve) - 1):
        r0, p0 = curve[i]
        r1, p1 = curve[i + 1]
        if r0 <= rank <= r1:
            frac = (rank - r0) / (r1 - r0)
            return round(p0 + (p1 - p0) * frac, 1)
    # Past the final anchor: decay toward zero at the tail slope.
    r_last, p_last = curve[-1]
    r_prev, p_prev = curve[-2]
    slope = (p_prev - p_last) / max(r_last - r_prev, 1)
    return round(max(p_last - slope * (rank - r_last), 8.0), 1)


SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}


def norm_name(name):
    """Match names across sources: case, punctuation, and generational suffixes."""
    s = name.lower().replace("'", "").replace(".", "").replace("-", " ")
    parts = [p for p in re.split(r"\s+", s) if p and p not in SUFFIXES]
    return " ".join(parts)


def load_expert_tiers():
    """Optional second opinion: a hand-built expert tier sheet in Full PPR.

    Keyed by normalized name per position, with the sheet's own ordering turned
    into a positional rank so it can be compared against consensus.
    """
    path = os.path.join(HERE, os.pardir, "data", "expert_tiers.json")
    if not os.path.exists(path):
        return None, {}
    with open(path) as f:
        blob = json.load(f)
    out = {}
    for pos, players in blob.get("positions", {}).items():
        ranked = sorted(players.items(), key=lambda kv: kv[1]["order"])
        for rank, (name, meta) in enumerate(ranked, start=1):
            out[(pos, norm_name(name))] = {"tier": meta["tier"], "posRank": rank}
    return blob.get("source"), out


def derive_byes(games):
    """True bye weeks from the real regular-season schedule."""
    played = defaultdict(set)
    max_week = 0
    for g in games:
        if g.get("season") != str(SEASON) or g.get("game_type") != "REG":
            continue
        wk = int(g["week"])
        max_week = max(max_week, wk)
        played[g["home_team"]].add(wk)
        played[g["away_team"]].add(wk)
    byes = {}
    for team, weeks in played.items():
        missing = sorted(set(range(1, max_week + 1)) - weeks)
        if len(missing) == 1:
            byes[team] = missing[0]
    return byes, max_week


def kmeans_1d(values, k, iters=60):
    """Deterministic 1-D k-means. Returns a cluster index per value.

    Values arrive sorted ascending. Centroids are seeded at evenly spaced
    quantiles, which makes the result stable across runs and lands the
    boundaries on genuine gaps rather than arbitrary cut points.
    """
    n = len(values)
    if k >= n:
        return list(range(n))
    if k <= 1:
        return [0] * n

    centroids = [values[min(int((i + 0.5) * n / k), n - 1)] for i in range(k)]
    assign = [0] * n
    for _ in range(iters):
        changed = False
        for i, v in enumerate(values):
            best_c, best_d = 0, None
            for c, cv in enumerate(centroids):
                d = abs(v - cv)
                if best_d is None or d < best_d:
                    best_c, best_d = c, d
            if assign[i] != best_c:
                assign[i] = best_c
                changed = True
        sums = [0.0] * k
        counts = [0] * k
        for i, v in enumerate(values):
            sums[assign[i]] += v
            counts[assign[i]] += 1
        for c in range(k):
            if counts[c]:
                centroids[c] = sums[c] / counts[c]
        if not changed:
            break
    return assign


def assign_tiers(players):
    """Group each position into tiers by clustering consensus rank.

    Tiers come from ECR rather than the modeled projection: the projection is a
    smooth function of rank, so its gaps are an artifact of the curve, whereas
    ECR gaps show where the experts themselves separate players.
    """
    by_pos = defaultdict(list)
    for p in players:
        by_pos[p["pos"]].append(p)

    for pos, group in by_pos.items():
        group.sort(key=lambda x: x["ecr"])
        k = max(1, round(len(group) / TIER_SIZE.get(pos, 5)))
        labels = kmeans_1d([p["ecr"] for p in group], k)
        # Relabel so tier numbers run 1..N in board order.
        seen = {}
        for p, lab in zip(group, labels):
            if lab not in seen:
                seen[lab] = len(seen) + 1
            p["tier"] = seen[lab]
        # Players left in each tier drive the drop-off alerts in the UI.
        sizes = defaultdict(int)
        for p in group:
            sizes[p["tier"]] += 1
        for p in group:
            p["tierSize"] = sizes[p["tier"]]


def main():
    print("Fetching sources...", file=sys.stderr)
    ecr_rows = read_csv(fetch(ECR_URL))
    values_rows = read_csv(fetch(VALUES_URL))
    games = read_csv(fetch(GAMES_URL))

    expert_source, expert = load_expert_tiers()
    if expert:
        print(f"  expert tiers: {len(expert)} players from {expert_source}", file=sys.stderr)

    byes, max_week = derive_byes(games)
    print(f"  schedule: {len(byes)} teams with byes, {max_week} weeks", file=sys.stderr)

    scrape_date = ecr_rows[0].get("scrape_date") if ecr_rows else None

    # Superflex ECR keyed by FantasyPros player id.
    sf_by_id = {}
    for r in values_rows:
        fid = r.get("fp_id")
        if fid:
            sf_by_id[fid] = {
                "ecr_1qb": num(r.get("ecr_1qb")),
                "ecr_2qb": num(r.get("ecr_2qb")),
                "age": num(r.get("age")),
            }

    overall = [r for r in ecr_rows if r.get("page_type") == "redraft-overall"]
    if not overall:
        print("ERROR: no redraft-overall rows found", file=sys.stderr)
        return 1
    overall.sort(key=lambda r: num(r.get("ecr"), 9999))

    # FantasyPros also publishes standalone per-position boards. They disagree
    # slightly with the overall board, so they are kept for reference only:
    # driving projections off them would make a player ranked lower overall
    # project higher, which reads as a bug on a board sorted by overall ECR.
    fp_pos_rank_by_id = {}
    for pos in POSITIONS:
        page = f"redraft-{pos.lower()}"
        rows = [r for r in ecr_rows if r.get("page_type") == page]
        rows.sort(key=lambda r: num(r.get("ecr"), 9999))
        for i, r in enumerate(rows, start=1):
            fp_pos_rank_by_id[r.get("id")] = i

    players = []
    seen = set()
    pos_counter = defaultdict(int)

    for r in overall:
        pid = r.get("id")
        name = (r.get("player") or "").strip()
        pos = (r.get("pos") or "").strip().upper()
        if not name or pos not in POSITIONS:
            continue
        key = (name, pos)
        if key in seen:
            continue
        seen.add(key)

        team = TEAM_FIX.get((r.get("tm") or "").strip().upper(), (r.get("tm") or "").strip().upper())
        # Rank within position by overall ECR, so the board order, projections,
        # and VORP all tell the same story.
        pos_counter[pos] += 1
        pos_rank = pos_counter[pos]

        bye = byes.get(team) or int(num(r.get("bye"), 0) or 0) or None
        sf = sf_by_id.get(pid, {})

        ecr = num(r.get("ecr"), 999.0)
        sd = num(r.get("sd"), 0.0) or 0.0

        players.append({
            "id": pid or f"{name}-{pos}",
            "name": name,
            "pos": pos,
            "team": team,
            "bye": bye,
            "ecr": round(ecr, 2),
            "sd": round(sd, 2),
            "best": int(num(r.get("best"), ecr) or ecr),
            "worst": int(num(r.get("worst"), ecr) or ecr),
            "posRank": pos_rank,
            "fpPosRank": fp_pos_rank_by_id.get(pid),
            "proj": project(pos, pos_rank),
            "sbnTier": None,
            "sbnPosRank": None,
            "ecr1qb": sf.get("ecr_1qb"),
            "ecr2qb": sf.get("ecr_2qb"),
            "age": sf.get("age"),
        })

    # Attach the expert sheet where a name matches.
    matched = 0
    for p in players:
        hit = expert.get((p["pos"], norm_name(p["name"])))
        if hit:
            p["sbnTier"] = hit["tier"]
            p["sbnPosRank"] = hit["posRank"]
            matched += 1
    if expert:
        print(f"  matched {matched} players to the expert sheet", file=sys.stderr)

    players.sort(key=lambda p: p["ecr"])
    for i, p in enumerate(players, start=1):
        p["rank"] = i

    assign_tiers(players)
    players.sort(key=lambda p: p["rank"])

    payload = {
        "meta": {
            "season": SEASON,
            "scrapeDate": scrape_date,
            "generatedAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
            "playerCount": len(players),
            "expertSource": expert_source,
            "sources": {
                "rankings": "FantasyPros consensus ECR via DynastyProcess",
                "superflex": "DynastyProcess player values",
                "schedule": "nflverse (real 2026 slate)",
            },
            "defaultPassTd": 6,
            "note": (
                "Ranks, standard deviation, best/worst, and bye weeks are real data. "
                "Projected points are modeled from positional rank using Full-PPR "
                "expected-value curves, not a per-player statistical projection."
            ),
        },
        "pointCurves": POINT_CURVES,
        # Both variants ship so the app can switch scoring without a rebuild.
        "qbCurves": {"4": build_qb_curve(4), "6": build_qb_curve(6)},
        "players": players,
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(payload, f, separators=(",", ":"))

    # Browsers block fetch() over file://, so the app loads its data as a plain
    # script instead. That keeps index.html openable straight off disk.
    with open(OUT_JS, "w") as f:
        f.write("window.PLAYER_DATA=")
        json.dump(payload, f, separators=(",", ":"))
        f.write(";\n")

    counts = defaultdict(int)
    for p in players:
        counts[p["pos"]] += 1
    print(f"Wrote {len(players)} players to {os.path.relpath(OUT)} and {os.path.relpath(OUT_JS)}", file=sys.stderr)
    print(f"  scraped {scrape_date} | {dict(counts)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
