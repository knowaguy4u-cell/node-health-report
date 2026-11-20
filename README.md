# Node Health Report

Pi Browser app for the Pi Next hackathon. Built by TMT Productions (Exploratus Digital LLC).

- `index.html` — the app
- `privacy.html` — privacy policy
- `terms.html` — terms of service

## Testnet payments

The static page stays on GitHub Pages. Deploy this repository separately as a
Vercel project (Other framework, repository root, no build command; Node 22 or
24). Install dependencies with `npm install`. Replace the single `API_BASE`
constant in `index.html` with the resulting HTTPS backend URL. Keep sandbox mode
on. Set these server-only Vercel environment variables:

- `PI_NETWORK_API_KEY`
- `PI_WALLET_SEED`

`.env.example` deliberately contains names only. Never commit populated env
files or place credentials in frontend code. The app wallet must be funded on
Testnet and match the payment's Pi-provided `from_address`.

All endpoints accept POST JSON and return JSON. Send `Authorization: Bearer`
with the Pi access token on each request (body `accessToken` is also supported).
OPTIONS preflight requires no token. Allowed origins are
`https://knowaguy4u-cell.github.io` and `https://testjra7998.pinet.com`.

| Endpoint | JSON body | Behavior |
| --- | --- | --- |
| `/api/payments/approve` | `{ "paymentId": "…" }` | Validates Pi identity, Testnet, direction, fixed price and product before approval. |
| `/api/payments/complete` | `{ "paymentId": "…", "txid": "…" }` | Revalidates and completes; records one health check entitlement. |
| `/api/payments/resume` | `{ "payment": { "identifier": "…" } }` | Reloads authoritative payment state; approves/completes or waits for the user transaction. |
| `/api/payout` | `{}` | Identifies the user, sends fixed 0.5 Test-Pi, and reconciles retries. |

The full health check is an entitlement record; actual node diagnostics remain
the existing page's build-in-progress placeholder. No node data is collected.

## Recovery and limitations

`api/_lib/store.js` is explicitly an **in-memory Testnet test implementation**.
Its locks, once-per-user record and fulfillment record work only within one warm
instance. Vercel functions can run in different instances, and cold starts lose
state. Before real deployment traffic, replace this with a shared durable store
with atomic updates and distributed locks, including a lock for the app wallet's
sequence. Store payment ID, transaction hash, signed envelope and state before
submission. Recovery tests simulate restoring this state in a new service; they
do not claim volatile memory survives a process crash.

Payout transitions are `creating → created → prepared → submitted → completed`.
Errors record `failed` while preserving all reconciliation fields. A lost create
response is recovered from Pi's incomplete server payments. If a prior create is
ambiguous and no payment is visible, the route returns
`payout_reconciliation_required` and never creates another payout automatically.
An unrelated ongoing app payment returns `payout_in_flight`.

The signed envelope and its hash are saved before Horizon submission. Retrying
looks up that hash, then completes the Pi payment. If necessary it resubmits only
the identical envelope, never builds a new transaction after an uncertain send.
If an envelope expires without confirmation, reconcile it manually; do not erase
the record or generate a replacement until the chain outcome is established.

## References and documentation differences

Read [Payments](https://developers.minepi.com/docs/accept-payment/Payments),
[Advanced Payments](https://developers.minepi.com/docs/accept-payment/PaymentsAdvanced)
and [Platform API](https://developers.minepi.com/docs/api-reference/PlatformAPI).
The advanced page delegates to the official
[Node helper](https://github.com/pi-apps/pi-nodejs). This implementation follows
its create → submit → complete flow and its
[transaction construction](https://github.com/pi-apps/pi-nodejs/blob/main/src/index.ts)
using `@stellar/stellar-sdk` directly so the signed envelope can be stored before
submission. The helper's single `submitPayment` call does not expose that
write-ahead step. Its
[published network configuration](https://github.com/pi-apps/pi-nodejs/blob/main/.env.production)
confirms `https://api.testnet.minepi.com` and the `Pi Testnet` passphrase.

The Platform API's documented `UserDTO` lists uid, credentials and optional
username, but does **not** list `wallet_address`, unlike the build spec's assumed
`/v2/me` response. The advanced docs promise the current recipient address on the
created payment. Per the spec this app fails closed with `missing_scope` unless
`/me` provides both the wallet permission and address; verify availability with
Pi before enabling payouts. Actual transaction destination always comes from
Pi's payment DTO, allowing Pi to choose the current wallet.

The Payments sample names its key `PI_API_KEY`; this project uses the required
`PI_NETWORK_API_KEY` instead. Completion also requires the user's token and
revalidates the purchase, preventing callers from bypassing approval validation.

## Tests

Run `npm test` or `node --test --test-isolation=none` (Node 22.8+).
These use Node's built-in test runner, mocked fetch for Pi and Horizon, and a
synthetic transaction builder. They cover frontend callbacks and auth timing,
validation, idempotency, once-per-user payouts, missing scopes, concurrency and
crash recovery. Signing with the real Stellar SDK and live Pi/Testnet calls
require an installed dependency and a separately configured Testnet environment.
The isolation flag allows individual test results to be reported in restricted
environments where subprocess test IPC is unavailable.

Privacy, terms and validation files have been preserved exactly as requested.
