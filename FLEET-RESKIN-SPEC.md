# Fleet Reskin Spec — Node Health Report

Commissioned by Tim, 2026-11-20. Design synthesis approved across four mock
rounds: **Pi Node Monitor's fleet grid** (structure) wearing **OrbitWatch's
observatory skin** (aesthetic), keeping this app's discipline (verdict first,
plain words, one fix named first).

## Design tokens (taken from orbitwatch.app's own stylesheet)

- Background: `#060b18` (deep-space navy, dark color-scheme)
- Primary text: `#e6edf7`
- Secondary text / hairlines: `#94a3b8` (hairlines at ~25% alpha, row rules ~16%)
- Healthy / synced signal: `#34d399` emerald, tint backgrounds at ~9% alpha
- Attention / fix-first: `#f59e0b` amber; emphasis panel is a gradient
  `linear-gradient(135deg, rgba(245,166,35,.15), rgba(245,166,35,.05))`
  with a ~35% alpha amber border
- Unreachable: `#f87171` at ~10% alpha pill tint
- Type: serif display (Georgia) for the headline verdict and fix-first body;
  system sans for UI labels; monospace for all numbers (ledger, blocks, gaps)
- Kickers: uppercase, letter-spaced (~.18em), slate
- Structure: editorial — kicker + date, hairline-separated entries, NO chunky
  cards, NO purple glass, NO gradients except the amber emphasis panel

## Layout (single column, phone-first, in this order)

1. Header row: `NODE HEALTH REPORT` wordmark (letterspaced caps) + status pill
   `AUTO-UPDATE · ACTIVE` (emerald tint) when watching is on
2. Observation block: kicker `FLEET OBSERVATION · <date>`, mono line
   `NETWORK LEDGER <seq> · PROTOCOL <version>`
3. Headline verdict (serif): `<N> nodes watched. <M> need(s) attention.` —
   singular/plural correct; when all healthy: `All <N> nodes are healthy.`
4. Fleet list — one entry per node, hairline-separated, each with:
   - Name (bold sans) + status pill: SYNCED (emerald) / BEHIND (amber) /
     UNREACHABLE (red) / NOT CHECKED (slate)
   - Mono stat row, 4 cells: BLOCK / BEHIND / PORTS / LAST SEEN
     (PORTS = open count of 10, e.g. `10/10`; LAST SEEN = relative, e.g.
     `seconds`, `4 min`, or `—`)
   - One plain-words line under the stats when the node is not healthy
     (e.g. "No ports answered · state changed today, 6:12 PM",
     "Catching up at about 900 ledgers an hour" — only when the rate is
     actually known from two observations; otherwise omit the rate)
5. Fix-first panel (amber gradient): `WHAT TO FIX FIRST` kicker + the single
   highest-priority fix across the fleet, from the existing ranked-fixes data
6. Network note (emerald tint) when protocol state is known: whether the
   fleet's nodes match the network protocol version, or that no upgrade is due
7. Footer: `Data: live probe + Horizon` · links: History · Add a node · Alerts

## Behavior

- **Fleet model (client):** the node list (label + host) persists in
  localStorage alongside the existing history. Add-node and remove-node
  controls. The existing single-node form becomes "add / check a node";
  checking a node runs the EXISTING check flow for that host and stores the
  report as that node's latest state.
- **Check all:** runs checks sequentially, showing per-node progress. The
  backend rate limit (60s per user) is real: if a check is rate-limited, mark
  that node `CHECK QUEUED` in plain words ("The network asks us to space
  checks out — this one runs in under a minute") and continue; never surface a
  raw error. Do NOT change backend rate-limit semantics in this build.
- **Entitlement semantics unchanged:** one purchase unlocks checks; amounts
  frozen (PRICE=1, PAYOUT=0.5); purchase/payout flows untouched.
- **Network data (backend):** extend the check response (or add a light
  network read) with the current protocol version from the Horizon root
  document (`current_protocol_version`). Tested like everything else.
- **State-change line:** derived from stored history (the timestamp at which
  the node's stored verdict last changed). If history has only one entry,
  omit the line. Never invent a change time.
- **Watching v1 is client-side state only** (list + history + last states).
  Server-side scheduled watching and push/email alerts are OUT of scope for
  this build — do not build them, do not imply they exist in the UI. The
  `AUTO-UPDATE · ACTIVE` pill refers to the fleet view refreshing stored
  states on open, and its wording must not promise background alerts.

## Data honesty (hard rules)

- No fabricated columns. Peers and Docker state are NOT visible to an outside
  probe — do not render them. The grid's four cells are BLOCK / BEHIND /
  PORTS / LAST SEEN because those are what the probe + Horizon actually know.
- Catch-up rate only from two real observations of the same node.
- Every number shown must trace to a probe result, a Horizon read, or stored
  history. Placeholder values in mocks (65,069,902 etc.) are NOT data.

## Invariants

- Do not touch Pi SDK init, API-base selection, payment, payout, or
  entitlement logic beyond what the fleet calls already do. (A separate
  unmerged branch owns host-aware init; keep this diff mergeable with it —
  presentation and additive features only.)
- Accessibility wins from the §4 pass must survive the dark reskin: 44px
  minimum targets, `:focus-visible` outline (adjust color for dark ground,
  keep it unmistakable), status always carried by text, never color alone,
  body-text contrast on `#060b18` must stay ≥ 4.5:1 (slate `#94a3b8` passes;
  verify any new color pairing).
- Full test suite green (142 on main at the time of writing). New behavior
  gets new tests in the existing style (node:test).
- privacy.html / terms.html: leave content unchanged; a matching dark
  background on those two pages is optional and only if it is a one-line
  change each.
