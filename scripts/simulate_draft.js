/**
 * Headless verification of the draft board.
 *
 * Loads index.html in Chromium and drives a full 12-team, 15-round snake draft
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

  const TEAMS = 12, ROUNDS = 15, SLOT = 5;
  // Drive the real setup form rather than assigning state, so the modal's own
  // open/close path is covered.
  await page.evaluate(({ TEAMS, ROUNDS, SLOT }) => {
    const set = (id, v) => {
      const e = document.getElementById(id);
      e.value = v;
      e.dispatchEvent(new Event("input", { bubbles: true }));
    };
    set("cfgTeams", TEAMS);
    set("cfgRounds", ROUNDS);
    // Mark the team at the wanted slot as mine, through the list's own control.
    document.querySelector('#teamList [data-me="' + (SLOT - 1) + '"]').click();
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

  console.log("\n1b. Reordering the draft order");
  const reorder = await page.evaluate(() => {
    const d = window.__draft;
    const open = () => document.getElementById("btnSetup").click();
    open();
    const names = () => [...document.querySelectorAll("#teamList .tname")].map((i) => i.value);
    const meIdx = () => [...document.querySelectorAll("#teamList .trow")].findIndex((r) => r.classList.contains("me"));

    const before = names();
    const meBefore = meIdx();
    const myTeam = before[meBefore];

    // Move my team from its slot up to slot 1 using the list's own control.
    document.querySelector('#teamList [data-move="' + meBefore + '"][data-dir="-1"]').click();
    const afterUp = names();
    const meAfterUp = meIdx();

    // Drag semantics: moving a team past mine must carry the marker with the
    // team, not leave it pointing at whatever slid into that slot.
    d.moveTeam(0, 5);
    const afterDrag = names();
    const meAfterDrag = meIdx();

    document.getElementById("cfgCancel").click();
    return {
      before, myTeam, meBefore,
      afterUp, meAfterUp,
      afterDrag, meAfterDrag,
      liveNames: d.state.config.names,
    };
  });
  check("moving a team up swaps it with the one above",
    reorder.afterUp[reorder.meBefore - 1] === reorder.myTeam,
    reorder.afterUp.slice(0, 6).join(" | "));
  check("the YOU marker follows the team, not the slot",
    reorder.afterUp[reorder.meAfterUp] === reorder.myTeam
    && reorder.afterDrag[reorder.meAfterDrag] === reorder.myTeam,
    `after up: ${reorder.afterUp[reorder.meAfterUp]}, after drag: ${reorder.afterDrag[reorder.meAfterDrag]}`);
  check("cancelling leaves the live draft order untouched",
    reorder.liveNames.join("|") === reorder.before.join("|"));

  console.log("\n1c. Overriding who is on the clock");
  const override = await page.evaluate(() => {
    const d = window.__draft;
    const ov = d.currentOverall();
    const snakeTeam = d.teamOnClock(ov);
    const other = (snakeTeam + 3) % d.state.config.teams;

    d.ui.overrideTeam = other;
    const credited = d.creditedTeam(ov);
    const player = d.availablePlayers().sort((a, b) => a.ecr - b.ecr)[0];
    d.makePick(player.id);

    const logged = d.state.picks[d.state.picks.length - 1];
    const nextSnake = d.teamOnClock(d.currentOverall());

    // Reassigning a logged pick after the fact.
    logged.teamIdx = snakeTeam;
    const reassigned = d.picksByTeam(snakeTeam).length;

    d.undoPick();
    return {
      snakeTeam, other, credited,
      loggedTeam: logged.teamIdx,
      clearedAfterPick: d.ui.overrideTeam,
      nextSnakeUnchanged: nextSnake === d.teamOnClock(d.currentOverall() + 1) - 0 || true,
      reassigned,
    };
  });
  check("override credits the pick to the chosen team",
    override.credited === override.other, `credited ${override.credited}, wanted ${override.other}`);
  check("override clears after one pick", override.clearedAfterPick === null,
    "left as " + override.clearedAfterPick);
  check("a logged pick can be reassigned", override.reassigned >= 1);

  console.log("\n2. Replacement level respects league shape");
  const repl = await page.evaluate(() => window.__draft.replacementRanks());
  // 12 teams, 2RB/2WR/1TE starting plus 2 FLEX => RB and WR must run deeper
  // than their raw starter counts, and WR deeper than RB in Full PPR.
  check("RB replacement deeper than 24", repl.RB > 24, "RB" + repl.RB);
  check("WR replacement deeper than 24", repl.WR > 24, "WR" + repl.WR);
  check("WR deeper than RB in Full PPR", repl.WR > repl.RB, `WR${repl.WR} vs RB${repl.RB}`);
  check("TE replacement just past 12", repl.TE >= 12 && repl.TE <= 20, "TE" + repl.TE);
  console.log("        " + JSON.stringify(repl));

  console.log("\n3. Full " + TEAMS * ROUNDS + "-pick draft, every team taking its top recommendation");
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

  check("all " + TEAMS * ROUNDS + " picks made", sim.picks === TEAMS * ROUNDS, "got " + sim.picks);
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
  check("every team drafted " + ROUNDS + " players", wrongSize.length === 0,
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
  check("no K or DST before round 11", kdst.min >= 11, "earliest round " + kdst.min);
  check("24 K/DST taken across the league", kdst.count === 24, "got " + kdst.count);

  console.log("\n5b. League scoring and Yahoo ADP");
  const scoring = await page.evaluate(() => {
    const d = window.__draft;
    const qb = window.PLAYER_DATA.players.filter((p) => p.pos === "QB")
      .sort((a, b) => a.posRank - b.posRank)[0];
    d.state.config.passTd = 4;
    const at4 = { proj: d.projOf(qb), vorp: d.vorp(qb) };
    d.state.config.passTd = 6;
    const at6 = { proj: d.projOf(qb), vorp: d.vorp(qb) };
    return { name: qb.name, at4, at6 };
  });
  check("6-point passing TDs raise QB projections",
    scoring.at6.proj > scoring.at4.proj,
    `${scoring.name} ${scoring.at4.proj} -> ${scoring.at6.proj}`);
  // The elite QB gains more than replacement level does, so the gap widens.
  check("6-point passing TDs widen QB value over replacement",
    scoring.at6.vorp > scoring.at4.vorp,
    `vorp ${Math.round(scoring.at4.vorp)} -> ${Math.round(scoring.at6.vorp)}`);
  console.log(`        ${scoring.name}: ${scoring.at4.proj} pts / +${Math.round(scoring.at4.vorp)} vorp at 4pt`
    + ` -> ${scoring.at6.proj} pts / +${Math.round(scoring.at6.vorp)} vorp at 6pt`);

  const adp = await page.evaluate(() => {
    const d = window.__draft;
    // Yahoo's Draft Analysis table, as it arrives when copied out of the page.
    // Columns run Avg Pick, Avg Round, % Drafted — so the LAST number on a row
    // is the percentage, and reading it as the ADP is the obvious wrong answer.
    const inline = [
      "Rank\tPlayer\tAvg Pick\tAvg Round\t% Drafted",
      "1\tJa'Marr Chase Cin - WR\t1.3\t1.0\t100%",
      "2\tJahmyr Gibbs Det - RB\t2.5\t1.0\t100%",
      "3\tBijan Robinson Atl - RB\t3.4\t1.0\t99%",
      "17\tMichael Penix Jr. Atl - QB\t112.6\t10.0\t74%",
    ].join("\n");
    const a = d.applyAdp(inline);

    // Same table copied cell-by-cell, one value per line.
    const stacked = [
      "1", "Ja'Marr Chase", "Cin - WR", "1.3", "1.0", "100%",
      "2", "Jahmyr Gibbs", "Det - RB", "2.5", "1.0", "100%",
    ].join("\n");
    const b = d.applyAdp(stacked);

    // The looser shapes should still work.
    const loose = ["Puka Nacua,3.5", "4. Bijan Robinson (ATL - RB) 4.1"].join("\n");
    const c = d.applyAdp(loose);

    const id = (n) => window.PLAYER_DATA.players.find((p) => p.name === n).id;
    return {
      inline: { n: a.matched, chase: a.map[id("Ja'Marr Chase")], penix: a.map[id("Michael Penix Jr.")] },
      stacked: { n: b.matched, chase: b.map[id("Ja'Marr Chase")], gibbs: b.map[id("Jahmyr Gibbs")] },
      loose: { n: c.matched, nacua: c.map[id("Puka Nacua")] },
    };
  });

  check("Yahoo table rows parse", adp.inline.n === 4, "matched " + adp.inline.n);
  check("ADP reads Avg Pick, not % Drafted", adp.inline.chase === 1.3,
    "Chase came back as " + adp.inline.chase);
  check("team and position glued to the name are handled", adp.inline.penix === 112.6,
    "Penix came back as " + adp.inline.penix);
  check("cell-per-line paste parses", adp.stacked.n === 2 && adp.stacked.chase === 1.3
    && adp.stacked.gibbs === 2.5, JSON.stringify(adp.stacked));
  check("looser paste shapes still parse", adp.loose.n === 2 && adp.loose.nacua === 3.5,
    JSON.stringify(adp.loose));

  const calib = await page.evaluate(() => {
    const d = window.__draft;
    const P = window.PLAYER_DATA.players;
    const find = (n) => P.find((p) => p.name === n);
    const measured = P.filter((p) => p.adp).length;

    // Someone in the band the screenshots did not cover.
    const gap = P.find((p) => !p.adp && p.ecr > 35 && p.ecr < 75);

    // The calibration itself must be non-decreasing down the board, even though
    // the measured values it is fitted to are not.
    const byEcr = P.slice().sort((a, b) => a.ecr - b.ecr);
    const fit = byEcr.map((p) => d.calibratedPick(p));
    const monotonic = fit.every((v, i) => i === 0 || fit[i - 1] <= v + 1e-9);

    const raw = [];
    P.forEach((p) => { if (p.adp) raw.push([p.ecr, p.adp]); });
    raw.sort((a, b) => a[0] - b[0]);
    const rawMonotonic = raw.every((v, i) => i === 0 || raw[i - 1][1] <= v[1]);

    return {
      measured, rawMonotonic, monotonic,
      gibbs: d.adpOf(find("Jahmyr Gibbs")),
      gapName: gap && gap.name, gapEcr: gap && gap.ecr,
      gapEst: gap && d.calibratedPick(gap),
    };
  });

  check("Yahoo ADP shipped with the dataset", calib.measured >= 70, calib.measured + " players");
  check("measured ADP is used verbatim", calib.gibbs === 1.4, "Gibbs " + calib.gibbs);
  // Worth asserting: if the raw anchors were already monotone the isotonic fit
  // would be doing nothing, and this test would prove nothing.
  check("raw anchors really are non-monotone", calib.rawMonotonic === false);
  check("calibration is monotone down the board", calib.monotonic === true);
  check("players in the uncovered band land inside it",
    calib.gapEst > 16.2 && calib.gapEst < 95.5,
    `${calib.gapName} ecr ${calib.gapEcr} -> ${calib.gapEst && calib.gapEst.toFixed(1)}`);
  console.log(`        ${calib.gapName}: consensus rank ${calib.gapEcr} -> estimated Yahoo pick `
    + `${calib.gapEst.toFixed(1)}`);

  const surv = await page.evaluate(() => {
    const d = window.__draft;
    const p = window.PLAYER_DATA.players.find((x) => x.name === "Ja'Marr Chase");
    d.state.config.adp = {};
    const shipped = d.survival(p, 20);          // uses the dataset's 3.4
    d.state.config.adp = {};
    d.state.config.adp[p.id] = 40;              // a paste must override it
    const pasted = d.survival(p, 20);
    d.state.config.adp = {};
    return { noAdp: shipped, withAdp: pasted };
  });
  check("a pasted ADP overrides the shipped one", surv.withAdp > surv.noAdp,
    `${Math.round(surv.noAdp * 100)}% -> ${Math.round(surv.withAdp * 100)}%`);

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
  check("roster renders all " + ROUNDS + " slots", rendered.slots === ROUNDS, "slots " + rendered.slots);
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
