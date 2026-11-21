# ROUND 3 SPEC — steal round from the 14-app teardown (2026-11-21)

Source: pi-app-playbook-2026-11-21.md (14 in-app teardowns + directory dossier).
Every item below is a pattern a top app proved, rebuilt to beat it under our rails.

## Rails (unchanged, hard)

- Frontend-only. api/ untouched. Amounts frozen: PRICE = 1, PAYOUT = 0.5.
- Pi.init / API-base lines byte-identical. Single <script> tag.
- No fabricated data: every rendered number derives from a real stored check or a real
  probe response. Unknown is rendered as unknown, never as 0 or a guess.
- Numbers in monospace, letters in Times. 44px targets, focus-visible, aria-live on
  verdict changes, status carried by text not color alone, AA contrast.
- Watching stays client-side; footer copy keeps saying alerts are not available.
- Each pure function ships with tests; suite must stay green end to end.

## Items

### 1. Score breakdown rows (steal: CiDi's thresholded task rows)
Under the health score on a node report, render the score's measured components as rows:
- "Ports — 10 of 10 open" · points in mono (per SCORE-SPEC: portsOpen × 5, max 50)
- "Sync — 3 blocks behind the network" · points in mono (gap bands per SCORE-SPEC, max 50)
Each row states the measurement and its points; the two rows sum to the displayed score.
Unscored reports (no node ledger entered) show no rows and keep the existing
"Not scored yet" line verbatim. Pure display of values the score already computes —
no scoring change.

### 2. Best score so far, dated (steal: Fruity Pi's best score — with its bug fixed)
On a node card and report, when the node has ≥2 scored checks in stored history, show:
"Best so far: 95 · 14 Nov" (mono number, human date). Derived only from stored scored
checks. Omitted entirely when fewer than 2 scored checks exist. Fruity Pi's players
complained their best was never saved; ours is saved, dated, and shown.

### 3. Fleet filter chips + worst-first order (steal: PiBox tabs, inverted to risk)
Above the fleet grid: chips **All / Needs attention / Healthy** with mono counts.
- The NEWEST check governs; an older scored check never overrides it.
- Healthy = newest score ≥ 70 and no section of the newest check is bad.
- Attention = newest score < 70 or a bad section of the newest check.
- Unmeasured = no scored newest check and no bad section, including never checked.
  Unmeasured counts under the Needs attention chip.
- The three-state vocabulary is healthy / attention / unmeasured.
- Bucket "Healthy" covers score bands Good (70–89) and Healthy (90–100).
Default order inside every view: worst first (lowest score first; never-checked nodes
sit at the end of Needs attention, labelled "Not checked yet" — unknown is not "worst",
it is unmeasured). Chip state is view-only; nothing is stored.

### 4. Stale marking (steal: GPM's strikethrough freshness grammar, minus fake urgency)
A node whose latest check is older than 24 hours renders its score de-emphasised:
mono digits struck through, a "STALE" tag, and the age in plain words
("checked 2 days ago"). Fresh scores render exactly as today. The verdict word is
never struck through — only the number ages. Threshold is a named constant (24h).

### 5. Fleet verdict strip (steal: PiBox's stats bar, made honest)
One mono line above the fleet grid, exact counts only:
"3 watched · 2 healthy · 1 needs a look · last check-all 12:04"
The check-all clause appears only when a check-all has actually completed on this
device (timestamp stored at completion); otherwise the clause is omitted, never faked.
"Healthy / needs a look" use the same definitions as item 3.

### 6. Sample report (steal: PayWithPi's public proof before the ask)
A "See a sample report" link beside the purchase surface opens a built-in sample:
- An example in the real format, internally consistent with SCORE-SPEC (ports 10 of 10
  open → 50; sync gap 3 → 45; score 95). It prints NO ledger numbers — no figure may
  carry a provenance it does not have.
- Host shown as "sample-node"; a banner at top and bottom: "Sample — an example in the
  real format, address hidden. Yours will name your node and show its own numbers."
- No share button, no proof export on the sample (both would mint a fake-looking
  artifact). The sample never enters history or the fleet.
Purpose: a visitor sees the verdict format, the score, the fix, and the limits before
the 1-Pi purchase is ever mentioned.

### 7. Empty-state grammar (steal: the directory's own empty state)
Fleet empty state and the item-3 no-results state adopt the directory pattern:
bold fact, gray instruction, one outline button. Nothing else — no illustration,
no apology copy.
- Empty fleet: "No nodes yet" / "Add a node and its first check takes under a minute." /
  [Add a node]
- Filter with no matches: "No nodes match" / "Clear the filter to see the whole fleet." /
  [Clear filter]

## Explicitly NOT in round 3

- No countdown to a next check (we run no scheduler; a countdown would promise an
  action the app never takes — footer honesty stands).
- No aggregate "nodes checked today" plaza strip (we have no server-side counts;
  a number we cannot measure does not ship).
- No check-depth modes (Quick/Full/Deep): our check is one honest depth; modes would
  imply shallower data we do not collect.
- Nothing from the ads-free spec; that remains Tim's separate call.

## Storage gate

Repair what can be interpreted, drop only what cannot. The storage gate repairs
legacy optional fields, normalizes hosts, and deduplicates saved reports and nodes
before rendering. A checkedAt or last check-all timestamp more than five minutes
in the future is rejected; a timestamp up to five minutes ahead is retained.
Fresh check responses use the gate for repair only so a live check is never lost.

## Known tensions

B8 grammar: the strip says "1 needs a look" and "N need a look" for every other
count; the verdict line retains its existing grammar. EDGE-CASES §6.25 resolution:
the sample keeps its breakdown rows — the real format includes them.
