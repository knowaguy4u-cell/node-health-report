# Improvement build — health score, trend, port-truth, framing, what-changed

Branch: score-build. Frontend only (index.html + test/frontend.test.js). Do NOT touch api/.
Everything below is computed from data the app already measures and stores. Nothing new is
invented, promised, or implied.

## 1. Health score 0–100 (per node, from a stored check report)

A report carries portsOpen (0–10, real probe count) and syncGap (ledgers behind the
network, or null when the user did not enter their node ledger).

- Ports points = portsOpen × 5 (max 50).
- Sync points from the gap: 0 → 50 · 1–10 → 45 · 11–1,000 → 30 · 1,001–100,000 → 15 ·
  over 100,000 → 0.
- Score = ports points + sync points. 100 is the max.
- If syncGap is null, there is NO score. Never estimate sync. The score area reads:
  "Not scored yet — enter your node's current ledger so sync can be measured."
- Band words: 90–100 "Healthy" · 70–89 "Good" · 40–69 "Needs a look" · 0–39 "At risk".
- The fix that raises it most: recoverable points = 50 − points, per side. The side with
  more recoverable points is the lever (tie → ports). Name that side's fix from the
  report's own fixes list (ports fixes: titles containing "port"; sync fixes: "Let your
  node catch up" / "Almost synced"). Copy: "The fix that raises it most: <title> (+<N>)."
  At score 100 the line reads: "Full score — run this check weekly to keep it."

## 2. Where the score renders

- Report view (#report): a HEALTH SCORE block — big score number (monospace, colored by
  band using the existing ok / warn / bad classes), "of 100 — <band>", then the
  raises-it-most line. Hidden until a report exists.
- Fleet entries: add a SCORE cell to the existing stats grid (BLOCK / BEHIND / PORTS /
  LAST SEEN / SCORE). Value is the score, or "—" when not scored. The fleet hero counts
  stay as they are — they are the rollup.

## 3. Sync-gap trend (per node, from stored history only)

From the node's own stored checks (history, oldest first), taking only checks where the
gap was measured: if at least 2 exist, render:
"Sync gap across your checks: <gaps, most recent last, at most the last 5> — closing."
Direction word: last gap smaller → "closing", larger → "growing", equal → "steady".
The label "across your checks" is mandatory — this is check history, never continuous
monitoring. Renders in the fleet entry and in the report view (for that report's host).
Absent when fewer than 2 measured checks exist.

## 4. Port-truth explainer (report view)

The ports row gains a permanent tag: OUTSIDE-VERIFIED. Under the report list, one line:
"Measured from outside — what the network sees. Pi's built-in checker often disagrees;
the outside check is the one that counts."

## 5. "App open ≠ node healthy" framing (report view)

One line in the report: "Judged by ledger progress against the network — a node can
have the Pi app open and still be behind."

## 6. What changed (per node, from stored history only)

Compare the node's latest stored check with the one before it. If both exist, render:
"Since your last check: …" composed only of facts that actually changed —
verdict word (healthy / needs attention / at risk), sync gap (old → new), ports open
(old → new of 10). If nothing changed: "Since your last check: no change."
Renders in the fleet entry and in the report view. Absent with fewer than 2 checks.
This complements the existing "state changed <date>" line; do not remove that.

## Locked rails (unchanged, verify before finishing)

- Amounts frozen (1 / 0.5 wherever they appear); Pi.init and API_BASE lines byte-identical;
  single <script> tag; api/ untouched.
- No peers, Docker, CPU, PC-health, ranking, or availability data anywhere. No alerts or
  background-monitoring promises — watching stays on-device, checks run while the page
  is open, and existing copy that says so stays verbatim.
- Palette and typography unchanged: #060b18 ground, slate, emerald, amber, error red
  #f87171; Times New Roman letters, ui-monospace numbers (every number, including every
  score and gap, inside a .num span or a dd).
- Accessibility holds: 44px targets, :focus-visible, aria-live regions, text-carried
  status, AA contrast on the dark ground.
- Check pacing (61-second rule), queue copy, and the payment lifecycle are untouched.

## Tests (extend test/frontend.test.js)

Cover: score math (100 case; ports-only loss; each sync band; null gap → no score);
lever choice including ports-warn (1 of 10 open) beating sync-bad (gap 2,000) on points;
score block rendering (number, band, raises-it-most line; unscored copy when gap null);
fleet SCORE cell (value and "—"); trend (label text, last-5 cap, closing/growing/steady,
absent under 2 measured checks); what-changed (verdict, gap, and ports changes; the
"no change" case; absent under 2 checks); explainer, OUTSIDE-VERIFIED tag, and framing
line present in the page. Full suite must pass.
