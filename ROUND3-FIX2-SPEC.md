# Round 3 — Fix pass 2 spec (from convergence cycle 2)

Base: round3-build @ a9abb57 (210/210). Every defect below was found by at
least one lane in cycle 2 and verified by Nova against the code. Frontend
only; api/ untouched; amounts stay 1 / 0.5; Pi.init and API_BASE byte-
identical; tests ship with their fix.

## E1 — the gate validates status and fixes fully (Codex D1 + Gemini Attack 1)
sanitizeReport currently shape-validates sections.sync/ports but only checks
sections.status for truthiness, and filters fixes entries on title only.
- sections.status gets the same rule as sync/ports: must be an object with a
  string line, else replaced by { level: '', line: 'Unknown' }.
- Every section's level is coerced: anything outside 'ok' | 'warn' | 'bad'
  becomes '' (the backend mints only those three; '' renders as the honest
  unknown everywhere levels are read).
- A fixes entry survives only with a string title; why/how are coerced to
  strings ('' when not a string). The fixes render joins only non-empty
  parts, so no "undefined" and no dangling separators can render.
Tests: stored status as string / {} / {level:'bad'} without line; fix with
title only; fix with non-string why; section level 'error' — all boot,
render, share, and prove without 'undefined' anywhere.

## E2 — non-array ports do not survive the gate (Gemini Attack 2)
If 'ports' in r and not an array: delete clean.ports and flag the repair.
The cycle-1 pinning test that asserted ports:{} survives unchanged is
reversed — update it to assert removal + flag.

## E3 — one canonical copy of a check across stores (Codex D2 + Gemini Attack 3)
At load, after history and lastReport are both sanitized: if a history entry
shares (host, checkedAt) with lastReport, the HISTORY copy governs —
lastReport is replaced by that copy before anything renders. If lastReport
has no twin, it joins history as today. The report view and the fleet card
can never show two scores for the same check again. Rationale (Codex,
cycle 2): with no persisted write-order metadata the app cannot infer which
store was written last, so the policy names the winner — history is the
record, lastReport is a view cache; the record wins.
Test: the cycle-2 divergence fixture (history syncGap 100 / lastReport
syncGap 0, same host+checkedAt) renders one score everywhere.

## E4 — queued retries are owned; runs cannot be orphaned or zombied
(Codex D3 + Gemini Attack 4 — one mechanism, two failure modes)
- A queued 429 timer belongs to its host. Runs register interest: when a
  run's attempt for a host finds a timer already queued, the run is added to
  that host's waiter set; when the retry resolves (success or final
  failure), completeCheckAll runs for every waiting run as well as the
  caller's own context.
- When the check-all loop aborts a run on an entitlement error
  (missing_access_token / invalid_access_token / no_completed_check), it
  cancels queued timers for the run's still-pending hosts and clears their
  CHECK QUEUED progress — no zombie check fires after the user was told the
  checks could not be completed.
Tests: (a) manual 429 first, then check-all 429 on the same host — the run
still completes and stamps when the retry succeeds; (b) two-node run, node 1
queued, node 2 entitlement error — run finishes with the partial copy, node
1's timer is cancelled, no later check fires.

## E5 — freshness scheduling is filter-independent (Gemini Attack 5)
scheduleFreshness collects latest reports from fleet, not visibleFleet().

## E6 — the live-response gate is pure and uses the server's clock
(Gemini §3 — and a spec deviation: ROUND3-FIX-SPEC step 1 required the
now-override; a9abb57 calls sanitizeReport(raw) bare with a `|| raw` fallback)
- sanitizeReport takes an options argument: { live: true } never sets
  storageRepaired (that flag describes the load pass only).
- performCheck calls sanitizeReport(raw, Date.parse(raw?.checkedAt) ||
  Date.now(), { live: true }). If a live response is uninterpretable
  (sanitize returns null), performCheck shows the honest failure line
  ('We could not run your check. Please try again.') and completes the run
  context as a failure — it never falls back to the unsanitized raw.
Tests: a live response needing repair does not light the storage-repaired
hint; a live response 10 minutes ahead of the device clock is accepted and
stored in sanitized form; an uninterpretable live response shows the
failure line and stores nothing.

## E7 — the freshness timer must cover gate-legal future reports (GPT addendum)
scheduleFreshness filters candidate delays to <= STALE_AFTER_MS, but a
report the gate legally accepts up to 5 minutes in the future has a stale
boundary at 24h + up to 5 minutes — filtered out, no timer, and it crosses
into stale silently until the next render/focus. Schedule the exact delay:
the candidate bound becomes STALE_AFTER_MS + 300000 (the future allowance),
or drop the upper filter and clamp only at a browser-safe maximum.
Test: a report 4 minutes in the future gets a boundary timer that fires at
its true 24h boundary under a controlled clock.

## Spec note
ROUND3-SPEC.md gains one paragraph under Storage gate: cross-store
canonical copy (E3) and the live/load flag split (E6).
