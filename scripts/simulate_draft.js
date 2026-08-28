/**
 * Headless verification of the draft board.
 *
 * Loads index.html in Chromium and drives a full 12-team, 16-round snake draft
 * through the same code path the UI uses, asserting the draft mechanics hold at
 * every pick. Run: node scripts/simulate_draft.js
 */
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const URL = "file://" + path.join(__dirname, "..", "index.html");

// The image ships Chromium under a versioned directory that may not match the
// revision this Playwright build expects, so find whatever is actually there.
function findChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  const candidates = [];
  let entries = [];
  try { entries = fs.readdirSync(root); } catch (e) { return undefined; }
  for (const e of entries) {
    candidates.push(path.join(root, e, "chrome-linux", "chrome"));
    candidates.push(path.join(root, e, "chrome-linux", "headless_shell"));
  }
  return candidates.find((p) => fs.existsSync(p));
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("  PASS  " + name);
  } else {
    failures++;
    console.log("  FAIL  " + name + (detail ? "  -> " + detail : ""));
  }
}

(async () => {
  const exe = findChromium();
  if (!exe) { console.error("No Chromium found under PLAYWRIGHT_BROWSERS_PATH"); process.exit(1); }
  const browser = await chromium.launch({ executablePath: exe });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // Google Fonts is unreachable from this sandbox; the page falls back cleanly,
  // so resource-load failures are not what this check is looking for.
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/Failed to load resource|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED/.test(t)) return;
    errors.push(t);
  });

  await page.goto(URL);
  await page.waitForFunction(() => window.__draft && window.__draft.state);

  console.log("\n1. Setup and snake ordering");

  const TEAMS = 12, ROUNDS = 16, SLOT = 5;
  // Drive the real setup form rather than assigning state, so the modal's own
  // open/close path is covered.
  await page.evaluate(({ TEAMS, ROUNDS, SLOT }) => {
    document.getElementById("cfgTeams").value = TEAMS;
    document.getElementById("cfgSlot").value = SLOT;
    document.getElementById("cfgRounds").value = ROUNDS;
    document.getElementById("cfgStart").click();
  }, { TEAMS, ROUNDS, SLOT });
  const cfgOk = await page.evaluate(() => JSON.stringify(window.__draft.state.config));
  check("setup form applied the league config",
    JSON.parse(cfgOk).teams === TEAMS && JSON.parse(cfgOk).slot === SLOT, cfgOk);

  // Snake order: round 1 runs 0..11, round 2 runs 11..0, and so on.
  const order = await page.evaluate((n) => {
    const out = [];
    for (let ov = 1; ov <= n; ov++) out.push(window.__draft.teamOnClock(ov));
    return out;
  }, TEAMS * 3);

  const r1 = order.slice(0, TEAMS);
  const r2 = order.slice(TEAMS, TEAMS * 2);
  const r3 = order.slice(TEAMS * 2, TEAMS * 3);
  check("round 1 ascends 0..11", r1.join(",") === [...Array(TEAMS).keys()].join(","), r1.join(","));
  check("round 2 reverses", r2.join(",") === [...Array(TEAMS).keys()].reverse().join(","), r2.join(","));
  check("round 3 ascends again", r3.join(",") === r1.join(","), r3.join(","));

  const turn = await page.evaluate(() => {
    const d = window.__draft;
    return { next: d.myNextOverall(), total: d.totalPicks() };
  });
  check("slot 5 picks 5th overall", turn.next === 5, "got " + turn.next);
  check("total picks = teams x rounds", turn.total === TEAMS * ROUNDS, "got " + turn.total);

  console.log("\n2. Replacement level respects league shape");
  const repl = await page.evaluate(() => window.__draft.replacementRanks());
  // 12 teams, 2RB/2WR/1TE starting plus 2 FLEX => RB and WR must run deeper
  // than their raw starter counts, and WR deeper than RB in Full PPR.
  check("RB replacement deeper than 24", repl.RB > 24, "RB" + repl.RB);
  check("WR replacement deeper than 24", repl.WR > 24, "WR" + repl.WR);
  check("WR deeper than RB in Full PPR", repl.WR > repl.RB, `WR${repl.WR} vs RB${repl.RB}`);
  check("TE replacement just past 12", repl.TE >= 12 && repl.TE <= 20, "TE" + repl.TE);
  console.log("        " + JSON.stringify(repl));

  console.log("\n3. Full 192-pick draft, every team taking its top recommendation");
  const sim = await page.evaluate(() => {
    const d = window.__draft;
    const seen = new Set();
    const problems = [];
    let recEmpty = 0;

    while (d.currentOverall() <= d.totalPicks()) {
      const ov = d.currentOverall();
      const team = d.teamOnClock(ov);
      const avail = d.availablePlayers().sort((a, b) => a.ecr - b.ecr);
      const recs = d.recommend(avail, team);
      if (!recs.length) { recEmpty++; break; }
      const pick = recs[0].p;

      if (seen.has(pick.id)) problems.push("duplicate player at pick " + ov + ": " + pick.name);
      seen.add(pick.id);

      const before = d.state.picks.length;
      d.makePick(pick.id);
      const after = d.state.picks.length;
      if (after !== before + 1) problems.push("pick " + ov + " did not register");

      const rec = d.state.picks[d.state.picks.length - 1];
      if (rec.teamIdx !== team) problems.push("pick " + ov + " credited to wrong team");
      if (rec.overall !== ov) problems.push("pick " + ov + " has wrong overall");
    }

    return {
      picks: d.state.picks.length,
      unique: seen.size,
      problems: problems,
      recEmpty: recEmpty,
      remaining: d.availablePlayers().length,
    };
  });

  check("all 192 picks made", sim.picks === TEAMS * ROUNDS, "got " + sim.picks);
  check("no player drafted twice", sim.unique === sim.picks, `${sim.unique} unique of ${sim.picks}`);
  check("recommendations never ran dry", sim.recEmpty === 0);
  check("no ordering problems", sim.problems.length === 0, sim.problems.slice(0, 3).join(" | "));
  check("board shrank correctly", sim.remaining === 516 - sim.picks, "left " + sim.remaining);

  console.log("\n4. Resulting rosters are legal and sane");
  const rosters = await page.evaluate((TEAMS) => {
    const d = window.__draft;
    const out = [];
    for (let i = 0; i < TEAMS; i++) {
      const mine = d.picksByTeam(i);
      const need = d.openStarterSlots(mine);
      const counts = {};
      mine.forEach((p) => { counts[p.pos] = (counts[p.pos] || 0) + 1; });
      out.push({
        team: i,
        size: mine.length,
        unfilled: Object.keys(need).filter((k) => need[k] > 0),
        counts: counts,
      });
    }
    return out;
  }, TEAMS);

  const wrongSize = rosters.filter((r) => r.size !== ROUNDS);
  check("every team drafted 16 players", wrongSize.length === 0,
    wrongSize.map((r) => `team${r.team}:${r.size}`).join(","));

  const unfilled = rosters.filter((r) => r.unfilled.length > 0);
  check("every team filled its starting lineup", unfilled.length === 0,
    unfilled.map((r) => `team${r.team} missing ${r.unfilled.join("/")}`).join(" | "));

  const noQB = rosters.filter((r) => !r.counts.QB);
  const noK = rosters.filter((r) => !r.counts.K);
  const noDST = rosters.filter((r) => !r.counts.DST);
  check("every team has a QB", noQB.length === 0, noQB.length + " without");
  check("every team has a K", noK.length === 0, noK.length + " without");
  check("every team has a DST", noDST.length === 0, noDST.length + " without");

  const hoarders = rosters.filter((r) => (r.counts.K || 0) > 1 || (r.counts.DST || 0) > 1);
  check("nobody hoarded kickers or defenses", hoarders.length === 0,
    hoarders.map((r) => `team${r.team} K${r.counts.K || 0} D${r.counts.DST || 0}`).join(","));

  const lopsided = rosters.filter((r) => Object.keys(r.counts).some((k) => r.counts[k] >= 7));
  check("no team hoarded 7+ of one position", lopsided.length === 0,
    lopsided.map((r) => `team${r.team} ${JSON.stringify(r.counts)}`).join(" | "));
  console.log("        sample roster: " + JSON.stringify(rosters[4].counts));

  console.log("\n5. K/DST timing — they should not go early");
  const kdst = await page.evaluate(() => {
    const d = window.__draft;
    const rounds = d.state.picks
      .filter((pk) => {
        const p = window.PLAYER_DATA.players.find((x) => x.id === pk.playerId);
        return p && (p.pos === "K" || p.pos === "DST");
      })
      .map((pk) => d.roundOf(pk.overall));
    return { min: Math.min.apply(null, rounds), count: rounds.length };
  });
  // A team that runs out of slack early legitimately fills K/DST in round 13;
  // what matters is that they never go while real starters are still on offer.
  check("no K or DST before round 12", kdst.min >= 12, "earliest round " + kdst.min);
  check("24 K/DST taken across the league", kdst.count === 24, "got " + kdst.count);

  console.log("\n6. Undo and persistence");
  const undo = await page.evaluate(() => {
    const d = window.__draft;
    const before = d.state.picks.length;
    const last = d.state.picks[before - 1].playerId;
    d.undoPick();
    const afterCount = d.state.picks.length;
    const back = d.availablePlayers().some((p) => p.id === last);
    const stored = JSON.parse(localStorage.getItem("draft-war-room-v1"));
    return { before, afterCount, back, storedPicks: stored ? stored.picks.length : -1 };
  });
  check("undo removes exactly one pick", undo.afterCount === undo.before - 1,
    `${undo.before} -> ${undo.afterCount}`);
  check("undone player returns to the board", undo.back);
  check("state persisted to localStorage", undo.storedPicks === undo.afterCount,
    `stored ${undo.storedPicks} vs ${undo.afterCount}`);

  const reloaded = await page.evaluate(async () => {
    location.reload();
  });
  await page.waitForFunction(() => window.__draft && window.__draft.state);
  const afterReload = await page.evaluate(() => window.__draft.state.picks.length);
  check("draft survives a page reload", afterReload === undo.afterCount,
    `${afterReload} vs ${undo.afterCount}`);

  console.log("\n7. Rendering");
  const rendered = await page.evaluate(() => ({
    rows: document.querySelectorAll("#boardBody tr").length,
    recs: document.querySelectorAll("#recs .rec").length,
    slots: document.querySelectorAll("#roster .slot").length,
    log: document.querySelectorAll("#paneLog .logrow").length,
    teams: document.querySelectorAll("#paneTeams .teamcard").length,
    clock: (document.getElementById("clock").textContent || "").trim().length > 0,
  }));
  check("board renders rows", rendered.rows > 0, "rows " + rendered.rows);
  check("roster renders all 16 slots", rendered.slots === 16, "slots " + rendered.slots);
  check("all 12 team cards render", rendered.teams === 12, "cards " + rendered.teams);
  check("draft log renders", rendered.log > 0, "rows " + rendered.log);
  check("clock renders", rendered.clock);

  // Several panels set display:flex/grid, which outranks the user-agent
  // [hidden] rule, so assert on what is actually visible rather than on markup.
  const vis = await page.evaluate(() => {
    const shown = (id) => {
      const e = document.getElementById(id);
      return !!(e && e.getClientRects().length);
    };
    return { setup: shown("setupBack"), log: shown("paneLog"), teams: shown("paneTeams") };
  });
  check("setup modal is closed during the draft", vis.setup === false);
  check("draft log tab is visible", vis.log === true);
  check("inactive rosters tab is hidden", vis.teams === false);

  await page.evaluate(() => document.getElementById("tabTeams").click());
  const vis2 = await page.evaluate(() => ({
    log: !!document.getElementById("paneLog").getClientRects().length,
    teams: !!document.getElementById("paneTeams").getClientRects().length,
  }));
  check("switching tabs shows rosters", vis2.teams === true);
  check("switching tabs hides the log", vis2.log === false);

  check("no JavaScript errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  await browser.close();

  console.log("\n" + (failures === 0
    ? "All checks passed."
    : failures + " CHECK(S) FAILED."));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("Simulation crashed:", e);
  process.exit(1);
});
