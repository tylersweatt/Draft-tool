# Draft War Room

A live snake-draft board for the 2026 NFL fantasy season. Track every team's
picks as they happen, and get a ranked recommendation for your own pick that
accounts for value over replacement, tier drop-offs, roster need, and bye-week
collisions.

Built for a **12-team, Full PPR, 2-FLEX** league, but every one of those is
configurable at setup.

## Using it

Open `index.html` in a browser. No server, no build step, no network needed
once the data file is built — which matters when the draft is happening and
the wifi isn't.

1. Set teams, your draft slot, rounds, and your starting lineup. This is asked
   once and remembered.
2. As each pick happens, click that player on the board. The pick is credited
   to whoever is on the clock, and the clock advances through the snake.
3. When it's your turn, the header goes amber and the right-hand panel ranks
   your best options with the reasoning behind each.

Everything persists to the browser's local storage, so a refresh or a closed
tab mid-draft doesn't lose the board.

**Keyboard:** `/` focuses search · type a name and press `Enter` to draft the
top match · `Ctrl/Cmd+Z` undoes the last pick.

## What the columns mean

| Column | What it tells you |
| --- | --- |
| **#** | Consensus overall rank (FantasyPros ECR) |
| **Tier** | Players grouped by where the experts actually separate them. `T3 ·1` in red means one player left in that tier |
| **SBN** | Second-opinion tier from the SB Nation Full-PPR sheet. `T2 ▲8` means that sheet ranks him 8 spots higher than consensus; `▼` means it fades him |
| **Proj** | Modeled Full-PPR season points |
| **VORP** | Points above a replacement-level starter at that position, given your league's size and lineup. This is the number to draft on |
| **Lasts?** | Probability the player survives until your next pick, from the spread in expert rankings |

## How the recommendation works

Ranked by value over replacement, then adjusted for:

- **Roster need** — an unfilled starting slot is worth more than another bench
  player, and gets progressively more urgent as your remaining picks run out.
- **Tier cliffs** — if a tier is about to break before your next turn, the cost
  of waiting is priced in.
- **Positional runs** — when four of the last six picks were RBs, you're told.
- **Bye collisions** — stacking a fourth starter on the same bye is penalized.
- **Marginal value** — a second kicker is worth nothing, and a first one is
  worth nothing until you're out of roster slack. Depth players are discounted
  because they only score if someone ahead of them gets hurt.

## Data

| What | Source | Real or modeled |
| --- | --- | --- |
| Consensus rank, ranking spread, best/worst | FantasyPros ECR via [DynastyProcess](https://github.com/dynastyprocess/data) | Real, scraped daily |
| Bye weeks | [nflverse](https://github.com/nflverse/nfldata) 2026 schedule | Real |
| Superflex / 2QB ranks | DynastyProcess values | Real |
| Projected points | Positional rank mapped through Full-PPR expected-value curves | **Modeled** |
| Second-opinion tiers | SB Nation Full-PPR tier sheet (`reference/`) | Real, hand-built by their analysts |

Projected points are not per-player statistical projections. They are a smooth
function of positional rank, which is what VORP needs — the gap between the
RB12 and the RB32 is the real input, not any individual forecast.

Refresh the rankings any time:

```sh
python3 scripts/build_data.py     # rewrites data/players.json and data/players.js
```

The two ranking sources are deliberately kept side by side rather than blended.
Consensus ECR is the spine of the board; the SB Nation sheet is shown as its own
column so a disagreement stays visible instead of averaging into a number that
hides it.

To re-parse a new tier sheet:

```sh
python3 scripts/parse_tiers.py reference/<sheet>.pdf   # writes data/expert_tiers.json
python3 scripts/build_data.py                          # rejoins it onto the players
```

## Repo layout

```
index.html               the app
data/players.json        generated dataset
data/players.js          same data as a script tag, so file:// works
scripts/build_data.py    fetches sources, models projections, assigns tiers
scripts/parse_tiers.py   reads a tier-sheet PDF by glyph coordinates
data/expert_tiers.json   parsed second-opinion tiers
reference/               source tier sheets
scripts/bundle.py        inlines everything into dist/draft-board.html
scripts/simulate_draft.js headless full-draft verification
```

## Verifying

```sh
node scripts/simulate_draft.js
```

Runs a complete 12-team, 16-round draft in headless Chromium against the real
UI code and asserts snake ordering, replacement levels, roster legality, K/DST
timing, undo, persistence across reload, and panel visibility.

Requires `npm install playwright` and a Chromium under
`PLAYWRIGHT_BROWSERS_PATH`.
