# Edge cases — Round 3, items 1–5

An adversarial test list for the five Round 3 items, not a claim of coverage. Every bullet
below is a case the suite must cover, or an ambiguity that must first be pinned to one
documented rule and then covered. A test that only uses freshly produced, fully-shaped
reports does not count: most of the risk lives in stored shapes this app wrote in earlier
rounds.

Scope: items **1 score breakdown rows**, **2 best so far**, **3 fleet chips + worst-first**,
**4 stale marking**, **5 verdict strip**. The sample report (item 6) and empty states
(item 7) are deliberately out of scope except where they interact with the five.

---

## How to read this list

- **Must** — required test. A missing test is an open edge case.
- Each case also asserts, implicitly:
  - no exception, and no `NaN`, `undefined`, `null`, `Infinity`, `Invalid Date`, or empty
    string rendered as data;
  - unknown is rendered as unknown (`—`, "Not checked yet", omitted clause) — **never** as
    `0`, a guess, or the current date;
  - no write to `localStorage` from a display-only path (these five items display; they do
    not record new check data);
  - the fix is in the pure function under test, not only in the renderer.
- "Pinned" means: choose a rule, write it down in the spec/comment, and test the choice.
  Do not leave the boundary to whatever the implementation happens to do.
- All time tests must stub `Date.now` and pass explicit ISO `checkedAt` strings. No test
  may depend on the machine's real clock, locale, or timezone.

## Fixtures

Baseline report (the shape the API returns and history stores):

```js
const base = {
  host: 'node.example',
  checkedAt: '2026-11-20T12:00:00.000Z',
  sections: {
    status: { level: 'ok', line: 'Healthy' },
    sync: { level: 'ok', line: '0 ledgers behind the network' },
    ports: { level: 'ok', line: 'All 10 node ports are open' },
  },
  fixes: [{ title: 'Almost synced', why: '…', how: '…' }],
  portsOpen: 10,
  syncGap: 0,
  ports: [{ port: 31400, open: true }, /* … 10 entries … */],
  networkLedger: 1000,
  nodeLedger: 1000,
  currentProtocolVersion: 24,
};
```

Legacy and malformed shapes that must all be exercised as stored input:

| ID | Shape |
| -- | ----- |
| L1 | `syncGap` key absent (pre-score-build report) |
| L2 | `syncGap: null` (ledger not entered) |
| L3 | `portsOpen` key absent |
| L4 | `portsOpen: "10"` (string, from an older serializer) |
| L5 | `syncGap: "3"` (string) |
| L6 | `sections.sync` or `sections.ports` missing |
| L7 | `sections.status` missing; also test it as `nhr:lastReport`, where the history filter does not run |
| L8 | `fixes` missing, `null`, or not an array |
| L9 | `checkedAt` as epoch number, `"not a date"`, empty string, or absent |
| L10 | two reports with identical `host` + `checkedAt` (migration duplicated the check) |
| L11 | history array out of chronological order |
| L12 | host casing/trailing dot differs between fleet entry and history (`Node.Example` vs `node.example`) |
| L13 | `currentProtocolVersion` missing vs `null` vs `0` |
| L14 | `ports: []`, partial port list, duplicate entries, entries missing `open` |
| L15 | `networkLedger: null` vs `networkLedger: 0` (zero is a real measured value) |
| L16 | `localStorage.getItem`/`setItem` throws (private mode / quota) |

Also test every item with **`nhr:fleet` present but `nhr:history` absent**, and the reverse
(history retained after the last node was removed). Both are reachable states today.

---

## 1. Score breakdown rows

### Stored-shape cases

1. **Null gap** — `syncGap: null` with `portsOpen: 10`: no breakdown rows at all; the score
   area keeps "Not scored yet — enter your node's current ledger so sync can be measured."
   verbatim; no `50` for ports appears as if it were a score.
2. **Missing gap key (L1)** — same as null: no rows, no score. `undefined` must not fall
   through a `==` check into the `0` band.
3. **Missing `portsOpen` (L3)** — no rows and no score; must not render "Ports — undefined of
   10 open" or `NaN` points.
4. **String numerals (L4/L5)** — `portsOpen: "10"`, `syncGap: "3"`: either both are coerced
   and produce the correct 95, or both are rejected and the report is unscored. Pick one,
   test it, and never subtract/compare strings.
5. **`portsOpen: 0`** — a legitimate measured result: rows show "Ports — 0 of 10 open" and
   `0` points, sync row still scored; must not be treated as "missing" and must not be
   rendered as `—`.
6. **`syncGap: 0`** — sync row shows `0` blocks and `50` points. Zero is not unknown.
7. **NaN / Infinity / negative gap** — huge, impossible values must not crash or produce
   negative points. Negative gap (node ahead) is not in SCORE-SPEC: pin the rule (treat as
   `0` band, or no score) and test the displayed points.
8. **Fractional / out-of-range `portsOpen`** (`9.5`, `11`, `-1`) — port counts are integers
   0–10. Pin clamp-or-reject and test points stay within 0–50.
9. **Legacy report loaded from `nhr:lastReport` only (L7)** — the render path that does not
   pass through the history filter must guard `sections` and `fixes` too.

### Score-math boundaries

10. Every sync band edge: gap `0 → 50`, `1 → 45`, `10 → 45`, `11 → 30`, `1000 → 30`,
    `1001 → 15`, `100000 → 15`, `100001 → 0`.
11. Ports points at every count `0..10` (`0, 5, …, 50`).
12. **Sum property** — for all 11 port counts × all 8 band edges, assert
    `portsPoints + syncPoints === displayed score`. The two rows must never disagree with
    the number above them.
13. **Score 100** — rows read 50 + 50 and the fix line reads "Full score — run this check
    weekly to keep it." (do not invent a breakdown row for a component that scored full).
14. **Score 95** — ports 10 of 10 (`50`), gap 3 (`45`); the sample in item 6 must match this
    exactly.
15. **Score exactly 70** — `ports 10 of 10` + gap `11` gives 80; find a real 70 combination
    (e.g. ports 5 of 10 + gap 0 = 75; ports 8 + gap 11 = 70) and assert the band is "Good"
    and the rows sum to 70 without rounding.
16. **Score 0** — ports 0 + gap 100001: rows `0` and `0`, band "At risk", no negative or
    wrapped points.

### Rendering and accessibility

17. Row copy exactly "Ports — 10 of 10 open" and "Sync — 3 blocks behind the network" (the
    measurement and its units are in the row, not only a points number).
18. Measurement digits **and** points are inside `.num`/mono spans; the em dash/labels are
    letters in Times. No bare number in the row text.
19. Rows are read as text, not conveyed by color; a screen reader gets
    "Ports — 10 of 10 open, 50 points" (points must not be an unlabelled trailing `50`).
20. Report view only: rows do not appear in the fleet card, proof export, share card, or the
    item-6 sample.
21. Changing the selected report/node replaces the rows completely; stale rows from the
    previous node must not linger (including the unscored case, where rows must be removed,
    not just hidden).
22. Breakdown rows are absent for any report whose score is absent — including a report
    with `portsOpen` but no gap, and a report with a gap but no `portsOpen`.

---

## 2. Best so far, dated

### Count and eligibility

1. **Zero scored checks** — no "Best so far" line anywhere (never "Best so far: —").
2. **One scored check** — omitted. Two observations of the same node do not create a best.
3. **Unscored checks do not count toward the two** — one scored + three `syncGap: null`
   checks still omits the line.
4. **Exactly two scored checks** — appears.
5. **A check with `portsOpen` missing is unscored** (scoreFor returns null); it must not
   count toward the two or contribute a best.
6. **All checks unscored** — omitted, even with ten stored checks.
7. **Never-checked fleet entry** — omitted (no history at all).

### Choice of value and date

8. **Best is the maximum, not the latest and not the first**: three checks 95, 80, 90 (in
   any order) → best 95 dated to the 95 check.
9. **Tie for maximum** — 95 on 1 Nov and 95 on 14 Nov: pin which date is shown (most recent
   tied score is the natural choice), test it, and assert fleet card and report agree.
10. **Tie after a lower latest** — 95, 80, 95: deterministic date, not the middle check.
11. **Zero is a real score** — checks 0 and 40 → best 0, dated; the line must appear, and 0
    must not be treated as "no best".
12. **Score exactly 70** — 70 and 69 → best 70, dated.
13. **Score 100** — best 100 with a human date.
14. **Out-of-order history (L11)** — insert the oldest check last; best and its date are
    unchanged.
15. **Duplicate stored check (L10)** — the same report written twice counts once; two copies
    of one scored check must still omit the line.
16. **Host matching** — checks for `other.example` never contribute to `node.example`, even
    when inserted between its checks. Test the `Host` casing variant (L12): decide exact vs
    normalized matching, and never show another node's best.
17. **Migration report in `nhr:lastReport`** that is also in history — dedupe by
    host + `checkedAt` before counting.

### Date rendering

18. Format exactly "Best so far: 95 · 14 Nov" — mono digits, human date, no ISO string, no
    time, no year for the current year (pin the cross-year rule).
19. **Fixed locale/timezone** — the test must pin `Intl`/timezone so "14 Nov" does not
    become "Nov 14" or shift a day. Test a check stored at `23:30Z` in a positive-offset
    zone.
20. **Cross-year** — a best from last year: pin whether the year is added; test 31 Dec/1 Jan.
21. **DST boundary** — a check stored an hour either side of a DST transition still renders
    the correct calendar date.
22. **Invalid `checkedAt`** — no "Invalid Date" and no best line from that check; if it is
    the only other scored check, the line must disappear rather than show a broken date.
23. **Future-dated check** (clock skew) — date is shown as stored; pin whether it is
    excluded; never render a negative age or "in 3 days".

### Rendering and persistence

24. Value and date are never persisted as a new field; a reload with the same storage yields
    the identical line, and no new `localStorage` key is written.
25. Line appears on both the fleet card and the report view for the same node, with the same
    number and date.
26. The best number is not struck by item 4 staleness (only the current score ages).
27. Best rendering does not throw when `fixes`/`sections`/`checkedAt` are legacy-shaped
    (L6–L9).
28. Best does not appear in the item-6 sample or in share/proof exports.

---

## 3. Fleet filter chips + worst-first

### Buckets and boundaries

1. **Empty fleet** — chips render with exact zero counts (mono `0`), or are omitted; pin
   which, and keep the item-7 "No nodes yet" state. No `NaN` counts.
2. **Never checked** — "Needs attention" bucket, but sorted at the **end** of that view and
   labelled "Not checked yet". Unknown is not "worst".
3. **Latest score 69, no bad section** — needs attention.
4. **Latest score exactly 70, no bad section** — healthy (the healthy boundary is `≥ 70`).
5. **Latest score 71** — healthy.
6. **Score < 70 but every section `ok`** — needs attention (score rule alone is enough).
7. **Score ≥ 70 but status `bad`** — needs attention.
8. **Score ≥ 70 but sync `bad`** — needs attention.
9. **Score ≥ 70 but ports `bad`** — needs attention.
10. **Score ≥ 70 with `warn` sections only** — healthy; "bad section" means level `bad`,
    not `warn`.
11. **Checked but unscored (`syncGap: null`)** — pin the bucket. "Latest scored check < 70"
    cannot fire; "latest check has a bad section" can. A node with an unscored latest and no
    bad section must not silently become healthy if it has never been scored; and a node
    previously scored 95 with a later unscored clean check must be classified by one
    documented rule, tested on both sides.
12. **Latest unscored but with a bad section** — needs attention regardless.
13. **Legacy missing `sections.sync`/`ports` (L6)** — missing sections are not `bad`;
    malformed report must not land in healthy by accident if its status is missing.
14. **Score exactly 0** — needs attention and sorts first, not confused with unknown.
15. **Stale node** — staleness does not change its bucket (a stale 95 is still healthy);
    only the display ages.
16. **Score `NaN`/missing in a fixture** — treated as unknown, never sorted as
    `-Infinity` to the top.

### Counts

17. Counts are exact: `All = Needs attention + Healthy`, recomputed after add, remove, and
    each completed check.
18. Counts are fleet length, not history length; a history-only host never inflates them.
19. Duplicate fleet hosts (possible via hand-edited storage) are counted once or rejected
    consistently; pin it.
20. Large counts are still mono and exact (no locale comma that turns `1234` into an
    unlabelled `1,234`; if grouped, the whole string stays inside `.num`).
21. Counts update live during check-all without double-counting a node that is `CHECKING`
    or `CHECK QUEUED` (the last stored score still classifies it).

### Ordering

22. **Worst first in All**: ascending score, lowest first.
23. **Worst first in Healthy**: still lowest-first among healthy nodes.
24. **Worst first in Needs attention**: lowest-first, then never-checked/unscored at the
    end.
25. **Tied scores** — two nodes at 40: deterministic secondary key (e.g. label/host).
    Assert identical order across reloads and after unrelated re-renders; do not rely on
    `Array.prototype.sort` stability.
26. **Unknown in All** — never-checked nodes sort after all measured scores, not before 0.
27. **All nodes tied / all unknown** — stable, no flicker between renders, no exception.
28. **One node removed while filtered** — remaining order is the same relative order; the
    last matching node removal produces the no-match state, not a crash.
29. **Check-all progress state** — a `CHECKING` node keeps its last score's position (or a
    pinned rule); no node disappears from the list mid-run.

### Filter mechanics

30. Chip labels exactly **All / Needs attention / Healthy**, counts in mono.
31. Active chip is exposed programmatically (`aria-pressed`, or tabs with selected state)
    and not by color alone; every chip is a 44px target with visible focus.
32. Filter state is **view-only** — switching chips writes nothing to `localStorage`, and a
    reload returns to All.
33. Filtering changes only the grid; the hero counts, verdict strip, fixes panel, and
    check-all scope stay fleet-wide.
34. **No matches** — the item-7 grammar appears ("No nodes match" / "Clear the filter to see
    the whole fleet." / "Clear filter"), with no leftover entries, no empty illustration,
    and no extra copy. Clear restores All and the full grid.
35. A chip whose count is 0 is still selectable and produces the no-match state.
36. Removing the last matching node while filtered shows the no-match state; clearing it
    restores the remaining nodes.
37. Filter + item 2 best + item 4 stale + item 5 strip on the same fleet: all four read
    from the same latest-check selection and never disagree.

---

## 4. Stale marking

### Threshold math

1. **Named constant** — threshold is one exported/named value (24h in ms); the test reads it
   rather than duplicating `86400000`.
2. **Just under** — `now - checkedAt = 24h - 1ms` → fresh, no strike/tag.
3. **Exactly 24h** — the boundary. Pin `>=` or `>` (spec says "older than 24 hours", which
   suggests `>`; choose one), document it, and assert both sides of the chosen operator.
4. **Just over** — `24h + 1ms` → stale.
5. **Minutes/hours under** — 1 min, 59 min, 23h59m → fresh with normal rendering.
6. **Future `checkedAt`** (clock skew) — age clamps to 0; never "checked -2 days ago";
   pin fresh-vs-stale.
7. **Invalid/missing `checkedAt`** — no "Invalid Date"/"NaN days ago"; treat as unknown
   age, no STALE tag, no crash.
8. **Check-all timestamp must not be used as the node's check time** — staleness reads the
   node's own latest check.

### Age wording

9. Under an hour → pin the wording ("checked 5 minutes ago").
10. `1 day` (24h) → singular "checked 1 day ago".
11. 47h59m → floor to "1 day ago" (pin floor vs round).
12. 48h → "checked 2 days ago" (the spec's example).
13. 30 days/365 days — plain words, consistent rule; no sudden ISO date or "1 month" if the
    implementation only supports days.
14. Timezone/DST does not change the age by ±1 day (compare instants, not local dates).

### Rendering

15. Only the score **digits** are struck through; the band word, "of 100", verdict word,
    STALE tag, and age remain unstruck and readable.
16. A `STALE` tag with text (not color-only) plus the plain-words age, e.g.
    "STALE · checked 2 days ago".
17. Accessible name of the score still contains the value; strikethrough is visual only, and
    the tag/age are associated with the score (not a floating sibling).
18. **Unscored stale report** — no number to strike; pin whether STALE/age still render. Do
    not strike the "Not scored yet" sentence.
19. **Never checked** — no "checked 0 days ago", no STALE.
20. Stale rendering appears in the report view and on the fleet card, including while the
    node is in a filtered view.
21. Stale does not change chip counts, sort order, the verdict strip, or the score value.
22. Stale rendering writes nothing to storage and does not re-date the check.
23. **Best-so-far number is not struck** (item 2); only the current score ages.
24. **Trend/what-changed numbers are not struck**; their copy still shows measured gaps.
25. Stale applies only to the latest check; an older stale check does not mark a node whose
    latest check is fresh.
26. Latest selection uses `checkedAt`, not array order (L11).

---

## 5. Fleet verdict strip

### Presence of the check-all clause

1. **Never run on this device** — the whole clause is omitted: no "last check-all", no
   em-dash placeholder, no "Invalid Date", no current time substituted.
2. **Run completed** — timestamp is stored at completion, not at start: start 11:59, finish
   12:04 → strip shows 12:04.
3. **Run aborted before any check** — missing/invalid access token or `no_completed_check`
   abort: no timestamp written; a pre-existing timestamp from an earlier completed run is
   left untouched.
4. **Run stopped early by auth failure mid-loop** — pin whether that counts as completed;
   test that a partial abort never overwrites a good timestamp with the abort moment.
5. **All checks individually failed** (e.g. `horizon_unavailable` for every node) — pin
   whether the loop counts as "completed"; whatever is chosen, the clause must not claim a
   successful check-all when nothing was measured.
6. **Empty fleet** — check-all is disabled; clicking must not stamp a time and the strip
   must not claim one.
7. **Legacy storage** — key absent, empty string, malformed date, or epoch number: clause
   omitted (or parsed only if unambiguous), never "Invalid Date".
8. **Future stored timestamp** — pin clamp/omit; never render a negative age.
9. **Page open/reload** — merely opening the app never creates or updates the timestamp.
10. **Second completed run** — replaces the timestamp; adding/removing nodes does not.
11. **Storage write failure** (`setItem` throws) — the finished run still does not crash;
    pin whether the in-memory strip shows the time for the session, and ensure no fake
    persisted value.

### Counts and grammar

12. **Exact counts** — "3 watched · 2 healthy · 1 needs a look · last check-all 12:04".
13. **0 nodes** — pin the strip: hidden, or "0 watched · 0 healthy · 0 need a look"; no
    singular/plural bug and no stray `NaN`.
14. **1 node** — singular grammar for "watched"/"healthy"/"needs a look" is defined and
    tested; the spec string uses plural forms, so pin how singular reads.
15. **Counts sum** — healthy + needs a look == watched for every fixture; no node counted
    twice or omitted.
16. **Healthy boundary** — 69 → needs a look; exactly 70 → healthy; 71 → healthy.
17. **Never checked** — needs a look, not healthy.
18. **Checked but unscored** — governed by the same rule as item 3; strip and chips must
    agree exactly.
19. **Bad section with score 100** — needs a look.
20. **Stale 95** — still healthy; freshness never changes the count.
21. **History-only hosts** — ignored; counts come from the fleet, and removing a node drops
    the watched count immediately while its history remains.
22. **Duplicate fleet hosts** — counted once or consistently rejected, never 2 watched for
    one node.
23. **Any active filter** — strip remains fleet-wide; "2 healthy" does not become "1
    healthy" because the Healthy chip is selected.

### Time rendering and accessibility

24. Time format exactly `HH:MM` with a leading zero at midnight ("00:04") and no seconds;
    noon is "12:04" (pin 12- vs 24-hour; the spec shows 12:04).
25. Locale/timezone pinned in the test; the same stored instant renders deterministically
    and never silently shifts the date. If the date differs from today, pin whether the day
    is included.
26. Counts and time are in `.num` spans; separators (`·`, `,`, letters) are Times.
27. The line updates politely (no shouting) after check-all; it must not announce every
    intermediate node count as a live-region message storm.
28. Strip is above the grid in DOM and visual order, and remains visible in every filter
    view including no-match and empty states (or is pinned hidden in empty).

---

## Cross-item interactions (must be covered together)

1. **Stale + best + attention + unscored** on the same node: score struck, best not struck,
   bucket by latest check, strip count agrees.
2. **Worst-first + ties + unknown**: 0 and never-checked nodes sort in the documented order;
   unknown is last, not "worst".
3. **Filter + no matches + strip**: strip still shows fleet-wide counts; empty state offers
   only "Clear filter".
4. **Legacy history (L1–L16) through all five renderers** in one pass: no exception, no
   `NaN`/`undefined`/`Invalid Date`, no storage write.
5. **Sample isolation** — the item-6 sample must never contribute to best, buckets, strip
   counts, staleness, or history; opening it changes no storage and no line in items 1–5.
6. **Check-all in flight** — buckets/order/strip stay coherent as `CHECKING`/`CHECK QUEUED`
   nodes update; no duplicate entries and no lost filter state.
7. **localStorage unavailable** — all five render the in-memory fleet and history (or the
   honest empty state) without throwing.

## Exit criteria

- Every case above is either a passing test or has a linked, written decision explaining
  why it cannot occur.
- Boundary tests (24h, 70, 100, 10, 1000, 100000, 0, two scored checks, 0/1/many nodes)
  each assert both sides of the boundary.
- Legacy fixtures L1–L16 run through every one of items 1–5 without a single unguarded
  property read, and the suite stays green end to end.
