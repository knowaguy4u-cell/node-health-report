# ROUND 3 — FIX PASS 4 SPEC (from cycle 4)

One root, two findings: the gate neither type-enforces nor canonicalizes `checkedAt` — the identity key's second half. Codex reproduced the array form (gate accepts `checkedAt: ["2026-11-20T12:00:00Z"]`; upsert compares by reference; duplicates mint a best-so-far from one check; reload adds a third copy). ChatGPT reproduced the alias form (two spellings of one instant — `2026-11-20T12:00:00Z` vs `2026-11-20T06:00:00-06:00` — key separately and count as two observations). Nova reproduced both against the live build. Frontend only (index.html + test/frontend.test.js). api/ untouched. Amounts stay 1 / 0.5. Pi.init line and API_BASE byte-identical. Tests ship with the fix (R13).

## G1 — checkedAt is a canonical string at the gate

In sanitizeReport:
1. The envelope check gains `typeof r.checkedAt !== 'string'` → drop (same uninterpretable-envelope class as a non-string host, R4″). This kills the array/number/object forms on every ingress, stored and live.
2. After the existing parse/future-window validation, rewrite `clean.checkedAt = new Date(Date.parse(r.checkedAt)).toISOString()` — canonical UTC ISO, the exact form the backend already mints (`new Date(...).toISOString()` in api/_lib/check.js), so genuine backend and stored data pass byte-identical and no repair is flagged for them.
3. A non-canonical-but-valid spelling (offset form, missing milliseconds) is normalized; the existing clean-vs-raw comparison flags it as a repair on the stored path (suppressed on the live path per R1′, while the canonical VALUE still applies — a live offset-spelling response keys correctly in-session).
4. Everything downstream (upsertReport keying, observations sorting, stale math, lastCheckAll handling is separate and already string-typed) consumes the canonical string unchanged. Do NOT change upsertReport's comparison — with canonical gate output, string equality IS instant equality.

Tests:
- (a) checkedAt as array / number / object → dropped at load; as a live response → the failed-check path, nothing stored.
- (b) Stored history with two spellings of one instant → after load: exactly one entry, and bestFor returns null (one distinct check).
- (c) A live response whose checkedAt uses an offset spelling for the same instant as a stored canonical entry → replaces it (one entry), and the stored value is the canonical form.
- (d) A canonical backend spelling passes byte-identical with storageRepaired still false.
- (e) The reload-third-copy path from Codex's report: stored history + lastReport under an alias spelling → one canonical copy governs after load.

## Amended ruling for cycle 5

- **R15′** replaces R15: one canonical upsert governs (host, checkedAt) identity on load and live success, where checkedAt is a gate-canonicalized UTC ISO string — type-enforced and spelling-normalized at the same gate; last arrival wins a conflict; best-so-far counts distinct checks only.
- All other rulings stand as agreed in cycle 4 (R1′+F6, R4″, R8″, R16 AGREE from GPT; Codex and Gemini verdicts as they land).

## Out of scope

No other changes. If the build surfaces a second non-canonical key field with the same alias problem, name it in the report — do not fix beyond this spec without a board ruling.
