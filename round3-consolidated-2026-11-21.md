# Round 3 — Consolidated Findings Register (all lanes, one document)

Compiled by Nova from: **Codex** (response-round review), **Freebuff** (edge-case
scorecard, 148 cases), **Gemini** (full audit), and **Nova's own probes** (12 cases
run against the assembled build). Duplicates merged; every item keeps the names of
the lanes that raised it. Verdicts on the assembled build (191/191 tests green —
the green suite misses everything below, which is the point of this register).

This register goes back to all four lanes with three questions: (1) Is anything
material missing or wrong? (2) Rank the upgrade materials — which fixes and pins
give the app the most real improvement? (3) Name anything better than what is
proposed here — a stronger fix, a better rule, an upgrade no lane raised.

## A. Demonstrated defects (reproduced, not inferred)

- **A1. Score inputs are unvalidated.** `scoreFor` accepts any finite numbers:
  portsOpen 11 renders "105 of 100 — Healthy" with "55 points"; 9.5 renders
  "97.5 of 100" and "47.5 points"; −1 renders "−5 points"; a negative syncGap
  renders "Sync — −50 blocks behind the network · 45 points". [Codex, Freebuff,
  Gemini, Nova probes P1–P4]
  *Selected fix:* scoreFor returns null (unscored) unless portsOpen is an integer
  0–10 and syncGap is an integer ≥ 0. The backend mints integers only; anything
  else is corrupt storage and must render as unmeasured, never as a number.
- **A2. Duplicate stored checks mint a false "Best so far".** One real check
  stored twice under the same host + checkedAt counts as two scored checks.
  [Codex, Freebuff, Gemini, Nova P5]
  *Selected fix:* dedupe by host + checkedAt inside observations().
- **A3. Duplicate fleet hosts are counted twice.** The strip reads "2 watched"
  and two cards render for one node. [Codex, Freebuff, Nova P7]
  *Selected fix:* dedupe the fleet by host at load (first entry wins).
- **A4. A malformed `fixes` field crashes the fix line.** A stored report whose
  fixes is a truthy non-array throws TypeError in scoreFix. [Codex, Nova P8]
  *Selected fix:* treat non-array fixes as no fixes (Array.isArray guard).
- **A5. Invalid stored dates render nonsense.** A lastReport with checkedAt
  "not a date" re-enters history through the load migration and the fleet card
  shows "LAST SEEN seconds". [Codex, Nova P9]
  *Selected fix:* the migration applies the same date validation the history
  filter already uses; invalid-date reports are dropped at load.
- **A6. Share/proof export can crash on a partial legacy report.** cardLines and
  proofText read sections.ports.line / sections.sync.line without optional
  chaining; a stored report missing those sections throws when the user taps
  Share or Download proof. [Gemini, Codex]
  *Selected fix:* optional chaining with the same "Unknown" fallback renderCheck
  already uses.
- **A7. The fleet sort comparator can return NaN.** Two checked-but-unscored
  nodes compare as Infinity − Infinity = NaN, which breaks sort transitivity.
  [Gemini]
  *Selected fix:* explicit rank handling — scored nodes by score, unscored after
  scored, never-checked last; no Infinity arithmetic.
- **A8. Duplicate port entries can misstate the ports line.** A stored ports
  array with the same port three times derives an "all three open" style line
  from three entries for one port. [Codex]
  *Selected fix:* count unique ports when deriving anything from the ports array.

## B. Rules to pin (the spec was silent or self-contradictory; Nova's ruling, lanes to challenge)

- **B1. The fleet bucket of a node whose latest check is unscored.** Spec item 3
  fires no clause for "scored 95, then a clean unscored check"; the merged code
  silently picks Needs attention. [Freebuff, Codex, Gemini-adjacent]
  *Nova's ruling:* the bucket reads the latest **scored** check (score and its
  sections). A node with no scored check reads its latest check: a bad section
  means attention; otherwise it is unmeasured — counted in attention only when it
  has never been checked; a checked-but-never-scored node with clean sections
  sits in attention too (it has no score to be healthy with), and the spec will
  say so plainly. The card always shows the newest check exactly as measured.
  Pin in ROUND3-SPEC; test both sides.
- **B2. Best-score ties show the oldest date.** The reduce keeps the first
  maximum. [Freebuff, Gemini, Nova P6]
  *Ruling:* a tie shows the **most recent** date — "best so far" is most useful
  at its freshest attainment. Fix the comparison; pin; test.
- **B3. A best from a previous year shows no year.** "95 · 31 Dec" is ambiguous
  across years. [Freebuff, Gemini]
  *Ruling:* append the year when the best is not from the current year.
- **B4. Fleet order ties have no secondary key.** Equal scores order by storage
  order — deterministic in one engine, unpinned across rewrites. [Freebuff,
  Codex, Gemini]
  *Ruling:* secondary key is the host string; pin; test.
- **B5. Host matching is case-sensitive.** A check stored as "Node.Example"
  never matches fleet entry "node.example" — the node renders NOT CHECKED
  despite a real stored check. [Freebuff, Codex]
  *Ruling:* hosts are DNS names; normalize to lowercase at every storage
  boundary (fleet add, history load, lastReport migration, check save).
- **B6. A future check-all timestamp is displayed as fact.** A stored stamp
  ahead of the clock renders "last check-all 01:25" for a run that has not
  happened. [Codex, Nova P12]
  *Ruling:* at load, a stamp later than now is invalid — omit the clause.
- **B7. STALE renders beside an unscored report, unassociated.** An unscored
  check two days old shows "Not scored yet…" plus "STALE · checked 2 days ago"
  as a sibling paragraph with no programmatic link to the score. [Freebuff]
  *Ruling:* keep the STALE tag (the check itself is old — that is honest), and
  associate it: aria-describedby from the score to the freshness line. Pin; test.
- **B8. Strip grammar is invariant.** "0 needs a look" / "3 needs a look" never
  inflects, while the verdict line below does. [Codex, Gemini]
  *Ruling:* the strip matches the spec's own example string and stays invariant;
  the verdict line keeps its inflection. Pin as designed, not a defect.
- **B9. "Fleet checks finished" can claim a finish that measured nothing.**
  When every check in a check-all fails (e.g. horizon_unavailable), the
  progress line still says checks finished, though the strip honestly stamps
  nothing. [Freebuff]
  *Ruling:* if a check-all produced zero reports, the completion copy says the
  checks could not complete and names the reason in plain words.

## C. Test pins the exit criteria demand (code mostly right, proof missing)

- **C1.** Healthy at exactly 70 vs attention at 65 (the real boundary — all
  scores are multiples of 5). [Freebuff, Codex]
- **C2.** The ports grid 0–10 and score 0 as a real, countable score. [Freebuff]
- **C3.** Stale at 24h + 1ms (only the fresh side of the boundary is tested).
  [Freebuff]
- **C4.** Throwing storage: every render path survives getItem/setItem throwing
  and works from memory. [Freebuff, Codex]
- **C5.** The strip clock pinned in tests (fixed timezone, exact HH:MM for a
  fixed instant) so a wrong hour is detectable. [Freebuff, Gemini]
- **C6.** The polite live region is not rebuilt when the strip text is
  unchanged during check-all progress renders. [Freebuff] (Small code guard +
  test.)

## D. Not findings

- Gemini's staging-folder `npm test` picked up an older pre-round-3 test copy
  in a subdirectory — an artifact of the staging folder, not the build. The
  governing count stands at Nova's 191/191 on the assembled tree.
- Codex's sandbox counts (187/190 with one skip) are the TCP-listener test its
  sandbox prohibits; outside the sandbox the suite is complete.

## Lane verdicts on the whole round, for the record

- **Codex:** "My items 1–5 do not meet EDGE-CASES' exit criteria as assembled."
  Sample honesty rails and Nova's three assembly calls judged correct.
- **Freebuff:** 130 of 148 cases covered, 18 exposed; the classifier removal
  judged right; its own items 6–7 verified unchanged by the merge.
- **Gemini:** all seven spec items PASS, hard rails PASS, honesty pattern PASS —
  with the edge gaps consolidated above, including two defects (A6, A7) it alone
  caught.
- **Nova:** every A-item above was reproduced by probe before entering this
  register (P1–P12). Nothing enters on a lane's word alone.
