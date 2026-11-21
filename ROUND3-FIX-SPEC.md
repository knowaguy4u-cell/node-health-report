# Round 3 — Fix Pass Spec (synthesized from the consolidation)

Source: round3-consolidated-2026-11-21.md + the four lane responses and Nova's
reconciliations #1–#5 on round3-lane-board-2026-11-21.md. Where this spec and an
earlier document disagree, THIS spec governs. All work is frontend-only
(index.html + test/frontend.test.js). Amounts stay 1 / 0.5. api/ untouched.
Tests ship with each step, not after the pass. Delete the scratch
test/probe.test.js as part of step 1.

## Step 1 — The load gate (one sanitize function; retires A2, A3, A5, A9, element crashes, B5, future timestamps)

Add `sanitizeReport(r, now)` and apply it at every storage ingress:
history load, lastReport load, fleet load (fleet entries), and to each fresh
/api/check response before render/persist (repair-only there: if sanitize
returns null for a fresh response, use the raw response — never lose a live
check to the gate).

sanitizeReport(r, now) returns a cleaned report or null:
- null when: r is not an object; host is not a non-empty string;
  sections?.status is missing; checkedAt does not parse; checkedAt is more
  than 5 minutes ahead of now (future-timestamp rule — same rule rejects a
  future nhr:lastCheckAll stamp at its own load).
- host := host.trim().toLowerCase() with ONE trailing dot stripped.
- fixes: non-array → []. Entries that are not objects or lack a string title
  are dropped from the array.
- ports (when an array): keep entries with an integer port in 31400–31409 and
  a boolean open. One entry per port: identical duplicates collapse; CONFLICTING
  entries for the same port (open differs) drop BOTH — that port is unknown.
  Non-array ports stays as-is (absent).
- sections.sync / sections.ports: if missing or malformed, fill
  { level: '', line: 'Unknown' } so export paths never dereference air.
  (cardLines/proofText ALSO get optional chaining with the same fallback —
  belt and braces.)
- syncGap: if present and (not an integer or < 0) → null (unmeasured, repaired).
- portsOpen: if present and (not an integer or outside 0–10) → null.
- Return the report; set a module flag `storageRepaired = true` whenever any
  field changed or any entry was dropped.

Load sequence:
- history := stored array → sanitize each → drop nulls → dedupe by
  host + checkedAt keeping the LAST occurrence in storage order.
- lastReport := sanitize(saved) BEFORE renderCheck; on null, lastReport = null
  and renderCheck is not called. The migration push uses the sanitized report
  (the dedupe above already handles a lastReport identical to a history entry:
  push only if its host+checkedAt is absent after dedupe).
- fleet := stored array → keep entries with a string host → normalize host as
  above → dedupe by host keeping the FIRST entry.
- lastCheckAll: not a string, unparseable, or > 5 min in the future → null.
- After normalization, write the normalized history/fleet back once (deliberate
  write-on-load) inside try/catch.
- If storageRepaired, the fleet view shows one hint line under the strip:
  "Some saved checks from an older version couldn't be read and were tidied up."
  (Shown on load only; no counts; not dismissible — it renders when the flag is
  set for this page load.)

## Step 2 — Score validation (A1)

scoreFor returns null unless Number.isInteger(portsOpen) in 0–10 AND
Number.isInteger(syncGap) ≥ 0. (The gate already nulls corrupt stored values;
this is the standing guard for every future caller.)

## Step 3 — Classifier pin + unmeasured reason (B1 final; Gemini §3.3/§3.4)

- fleetHealth stays as implemented — the NEWEST check governs: healthy iff
  scoreFor(latest) ≥ 70 and no section of latest is bad. Pin in ROUND3-SPEC
  item 3 with the three-state vocabulary: healthy / attention / unmeasured
  (unmeasured = no scored newest check and no bad section; it counts under the
  Needs attention chip). Add the spec sentence: bucket "Healthy" covers score
  bands Good (70–89) and Healthy (90–100).
- Fleet card hint: when the newest check is unscored AND the host has at least
  one scored check in history, append to the card's words: "Sync unmeasured on
  the latest check". (When it has never been scored, the existing unscored
  framing stands.)
- visibleFleet() becomes the single source: it returns
  fleetOrder(fleet) filtered by the active filter; renderFleet iterates it for
  both the empty-state decision and the cards.

## Step 4 — Fleet order (A7 cleanup + B4)

Replace the comparator with explicit tiers (Gemini's shape):
rank(r) = !r → [2, 0]; scoreFor(r) → [0, value]; else [1, 0].
Sort by tier, then score ascending (worst first), then host (localeCompare).

## Step 5 — Check-all run identity (B9 expanded; Gemini §1.4 leak)

- A run is an object { hosts: Set(snapshot at click), pending: Set, done: 0,
  failed: 0 } stored in `activeRun`. performCheck accepts an optional run;
  only calls carrying the active run update it. Manual checks pass no run and
  never touch it.
- A host completes its run entry on success (done++) or on a final failure
  (failed++: non-429 errors and network errors). A 429 keeps the host pending;
  its queued retry carries the same run. A retry whose run is no longer active
  still performs the check but touches no run state.
- Removing a node deletes its host from the active run's pending set (a removed
  node can neither complete nor block the run).
- When pending empties: if failed === 0 → stamp lastCheckAll (existing rule)
  and keep the existing completion copy. If done > 0 and failed > 0 → progress
  line: "Checked N of M nodes — the rest could not be measured this time." and
  NO stamp. If done === 0 → progress line: "The checks could not be completed —
  " + the plain-words reason of the last failure (the same text the per-node
  result line already shows). No stamp.
- The check-all click handler passes its run through checkNode/pacing.

## Step 6 — Best-so-far pins (B2, B3)

- Tie: the reduce keeps the MOST RECENT tied check (>= over ascending
  observations).
- Format: 'Best so far: 95 · 14 Nov' normally; when the best's UTC year differs
  from the current UTC year, 'Best so far: 95 · 31 Dec 2025'.

## Step 7 — Strip finish (B8 inflection, date qualification, C6)

- Counts clause inflects: exactly 1 → "1 needs a look"; otherwise "N need a
  look". (Verdict line unchanged.)
- lastCheckAll clause: same local day → ' · last check-all HH:MM'; older →
  ' · last check-all HH:MM · D Mon' (en-GB day + short month, local time).
- renderFleet writes the strip only when the composed text differs from what
  it last wrote (module-level lastStripText). The element stays
  aria-live="polite".

## Step 8 — Stale finish (B7 scoped, B10)

- Report view: #score-value gets aria-describedby="score-freshness" (both
  render in the same report; when freshness is hidden the reference is inert).
- Fleet card: when the score cell is stale, its dd gets
  aria-label "<score>, stale, <age>" (age = staleAge text).
- Freshness refresh: on visibilitychange (to visible) and on window focus,
  re-run renderFleet() and, if a report is on screen, renderReportExtras
  (lastReport). Plus one timer: after each render, if any visible report
  crosses its 24h boundary within the next 24h, set a single timeout to that
  soonest boundary (+50ms) that re-renders the same way; clear/replace it on
  each render.

## Step 9 — Sample + leftovers (A10)

- Sample markup: wrap the bare 3 in "3 blocks behind the network" (the
  Blockchain sync line) in <span class="num">3</span>, matching the sample's
  own breakdown row.

## Tests (ship per step; suite must stay green throughout)

- Gate: each repair and each drop rule; dedupe identical vs conflicting
  (last wins); port conflict → unknown; host case/dot collapse across fleet +
  history; future checkedAt dropped at +6 min, kept at +4 min; future stamp
  nulled; fixes [null] and ports [null] fixtures render without throwing;
  scored fixes-less legacy report survives load and counts toward bestFor;
  boot from a scored fixes-malformed lastReport renders the app (fleet +
  report) without throwing; storageRepaired line appears exactly when a change
  happened.
- A1: portsOpen grid — 0, 10 score; 11, -1, 9.5, "10" unscored; syncGap -1
  unscored; score 0 is a real score (bestFor/fleetOrder fixtures).
- B1: scored 95 then newer unscored bad-section → attention; scored 95 then
  newer unscored clean → attention WITH the "Sync unmeasured on the latest
  check" hint; newest scored 70 clean → healthy; 65 → attention.
- Order: tiers fixture (scored 30, scored 90, unscored, never-checked) →
  [30, 90, unscored, never]; equal scores → host order.
- Run identity: manual success mid-run does not complete the run; removal of
  the last pending host completes it; partial run copy exact; zero-done copy
  carries the reason; 429 retry carrying a dead run stamps nothing.
- bestFor: tie → later date; cross-year format; same-year format unchanged.
- Strip: "1 needs a look" vs "2 need a look"; old stamp shows the date clause;
  today's stamp does not; unchanged text → strip DOM node untouched on a
  progress re-render (assert textContent setter not re-invoked by identity of
  child nodes).
- Stale: aria-describedby present; fleet dd aria-label when stale, absent when
  fresh; visibilitychange re-render marks a crossed boundary (controlled
  clock).
- C1–C5 pins from the register (70 vs 65; ports grid; 24h+1ms; throwing
  storage across load + render + persist; strip clock pinned with TZ=UTC and
  an exact HH:MM for a fixed instant).
- C7 interactions: removing the last filtered match shows the no-match empty
  state; strip/chip counts stay consistent after add + remove + check;
  legacy fixture (L6-shaped lastReport) through render + share + proof without
  throwing.

## Spec documents

- Amend ROUND3-SPEC.md: item 3 gains the B1 pin + three-state vocabulary + the
  Healthy = Good + Healthy sentence; a new "Storage gate" section states the
  repair principle ("repair what can be interpreted, drop only what cannot")
  and the future-timestamp rule; a closing "Known tensions" note records the
  B8 grammar decision and the EDGE-CASES §6.25 resolution (sample keeps its
  breakdown rows — the real format includes them).
- Do not edit EDGE-CASES.md, the board, or any api/ file.
