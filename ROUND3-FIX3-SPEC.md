# ROUND 3 — FIX PASS 3 SPEC (from cycle 3)

Convergence target: the canonical contract holds on EVERY ingress — one shape (cycle 2), one copy per check, one acceptance policy (cycle 3). Frontend only (index.html + test/frontend.test.js). api/ untouched. Amounts stay 1 / 0.5. Pi.init line and API_BASE byte-identical. Tests ship with each fix (R13). Every fix names the cycle-3 finding it closes.

## F1 — Canonical upsert on live success (Codex Probe B + GPT, convergent)

Today: load resolves (host, checkedAt) identity through a map (index.html:562–579), but live success appends unconditionally (`history.push(value)`, :1002). One check identity can therefore exist twice in-session: bestFor counts entries, so a replayed/conflicting second response for the same key can satisfy the two-observation best-so-far threshold from ONE distinct check, and pre-/post-reload displays diverge.

Fix: one canonical insertion operation used by BOTH load and live success. On live success, before appending: if history already holds an entry with the same normalized (host, checkedAt) key, REPLACE that entry with the new value (last arrival wins — the same conflict policy as load's last-in-storage-order rule); otherwise append. lastReport references the canonical record either way. Load's existing behavior must not change observably (route it through the same operation if that is the cleanest shape, but its rulings R1′/R4′ stand).

Tests: (a) identical live replay → exactly one history entry, no best-so-far line from a single identity; (b) conflicting live replay (same key, different syncGap) → one entry, the later measurements govern every surface (report, fleet, best, cardLines, proofText); (c) live success for a key already in stored history → replaced, not duplicated, and consistent after a simulated reload.

## F2 — Live responses are bound to the requested host (GPT, new)

Today: performCheck accepts any sanitized 200 response; value.host is never compared to node.host (:977–1002). A valid report for b.example would be stored and rendered as the result of checking a.example.

Fix: after sanitization, if value.host !== node.host (both already normalized by the gate / addNode), treat the response as a failed check: the honest failure line ("We could not run your check. Please try again."), the run completes as failed for that host, NOTHING is stored (no history append, no lastReport change, no REPORT_KEY write, no fleet observation).

Test: wrong-host 200 through performCheck → failure line shown, history/lastReport/storage untouched; right-host 200 still succeeds (existing tests cover).

## F3 — Freshness scheduling covers the full accepted domain (Codex Probe C)

Today: scheduleFreshness admits delays only up to STALE_AFTER_MS + 300000 (:911) — the STORED-input future allowance. But E6 deliberately accepts live responses judged on the server's clock, with skew beyond five minutes. An accepted live report ten minutes ahead has a boundary delay of 24h + 10min → filtered out → no timer → with the page left open it crosses stale silently.

Fix: schedule every accepted report's boundary. Remove the acceptance-window upper filter; the only bound is a browser-safe timer cap — if a computed delay exceeds 2^31 − 1 ms, schedule at the cap and let the firing recompute (delays in this app are ~24h + skew, so the cap is a formality, but the code must not silently drop a boundary). Keep: fleet-wide collection (E5), +50 ms epsilon, single timer, recompute on fire.

Test: a live-accepted report with checkedAt ten minutes ahead of device now gets a timer whose delay equals its true boundary (24h + 10min, ± tolerance); advancing the controlled clock past the boundary marks it stale without any render/focus event. The existing four-minute stored case keeps passing.

## F4 — R4′ ruling text corrected (Codex + GPT, convergent; NO code change)

Nova's R4′ text said an invalid stored lastReport "is dropped at load, including uninterpretable status." That contradicts the adopted gate policy (E1): a malformed SECTION inside an interpretable envelope is repaired to {level:'', line:'Unknown'} and the report retained — both lanes verified the implementation does exactly this, and the repair principle (R1′) is the governing policy. The ruling text was wrong, not the code.

R4″ (replaces R4′): "A stored lastReport whose ENVELOPE is uninterpretable — no host, no sections object, unparseable or out-of-window checkedAt — is dropped at load. A malformed section or fix inside an interpretable envelope is repaired per R1′ and the report is retained and rendered with the repaired values." Add a pinning test if one does not already assert retention-with-repair for a status:{} lastReport through load AND proof export. ROUND3-SPEC.md's storage-gate paragraph gains one sentence stating this envelope/section split.

## F5 — Reload clock policy, pinned in the spec (Codex, deeper point; documentation, NO code change)

Codex's executed probe: a live report accepted at +10 min server skew is dropped if the page reloads immediately, because load judges stored timestamps against the device clock with the five-minute allowance. Ruled: this is the deliberate policy, now written down — live acceptance trusts the responding server's own timestamp for that response (E6); stored acceptance is judged at load against the device clock, because a stored future timestamp cannot be distinguished from a forged or corrupted one. A page left open keeps the accepted report and its (F3-fixed) stale timer; a reload re-judges it as stored data. ROUND3-SPEC.md's storage-gate paragraph gains this paragraph verbatim in substance. If a lane contests the policy itself in cycle 4 — with a better rule that keeps the anti-forgery property — it reopens as a policy question, not a defect.

## F6 — Gate consistency for counts and display scalars (Gemini §3, adopted)

Gemini's deeper finding: sanitizeReport validates portsOpen and the ports array independently, so a corrupted stored report can make two surfaces disagree (breakdown reads portsOpen "10 of 10 · 50 points" while the Testnet2 note reads a 3-entry array). The gate itself can create the seam: stripping conflicting port entries shrinks the array while portsOpen stays. Also, networkLedger / nodeLedger / currentProtocolVersion pass through unvalidated, so a corrupted stored string renders as-is.

Fix, in sanitizeReport: (a) for each of networkLedger, nodeLedger, currentProtocolVersion — if present and not a non-negative integer, set it to null (renders fall back to their existing unknown/absent paths — verify each render site tolerates null; the backend mints integers or null already). (b) If the sanitized ports array is COMPLETE (exactly 10 entries) and portsOpen is non-null, require portsOpen === count of open entries; on mismatch set portsOpen to the array's open count and flag the repair. A partial array (post-strip or Testnet-era) does not trigger the rule: portsOpen governs the count, the array governs per-port display — that split is the standing semantic, now stated.

Tests: corrupted scalar → null + flag; complete array with lying portsOpen → corrected to the array count + flag; partial array with differing portsOpen → untouched, no flag.

## Amended rulings for cycle 4

- R1′ stands (AGREE ×3 in cycle 3, counting Gemini's pending verdict when it lands).
- R4″ replaces R4′ (envelope dropped / section repaired).
- R6′ stands (live judged on server clock — AGREE Codex + GPT).
- R7′ stands (AGREE Codex + GPT; no new defect found).
- R8″ replaces R8′: freshness scheduling covers EVERY accepted report's boundary, stored or live, with no acceptance-window upper filter (F3).
- NEW R15: one canonical upsert governs identity on load and live success; last arrival wins a key conflict (F1).
- NEW R16: a live response is accepted only for the host that was requested (F2).
- R2, R3, R5, R9–R14 stand as agreed.

## Out of scope

No backend change. No new features. The parked improvement candidates stay parked. Convergence is judged on the amended set above.
