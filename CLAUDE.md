# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Ground Truth" — a hackathon project (Monad testnet) where phones sign a network-quality
claim + measurement with a passkey (P-256 secure-element key), a Solidity contract verifies
the signature with Monad's native EIP-7951 precompile (`0x0100`) and writes per-zone
aggregates, and a projector page renders the venue's coverage map plus a live attack/refusal
ticker built from that on-chain state. See `README.md` for the full design rationale and
`docs/PITCH.md` for the stage talk track — read both before making product-level changes,
they explain *why* things are shaped this way (e.g. why the chain is deliberately not in the
control loop, why `commitBatch` never reverts, why the map lives in contract storage).

## Commands

```bash
npm run prebuild   # solc-js compiles contracts/GroundTruth.sol -> out/*.abi.json, out/*.bin, lib/abi.js (generated, do not edit)
npm run sim         # deploy (or reuse/recover an existing deployment) + full on-chain assertion suite against testnet, ~30s
npm run dev         # http://localhost:3000 (attendee page) and /venue (projector globe), /venue/flat (fallback)
npm run mock        # node script/mock_phone.mjs [base-url] [count] — scripted attendees against a running dev server, no phones needed
npm test            # node test/cose.mjs — pure-JS unit test of the browser COSE/CBOR key parser in lib/passkey.js
npm run build       # next build
```

There is no test runner/framework — `test/cose.mjs` and `script/deploy_demo.mjs` are plain
Node scripts that print `PASS`/`FAIL` lines and `process.exit(1)` on failure. `npm run sim`
spends real testnet MON from the sponsor key. `script/p256_probe.mjs` is a
standalone script (not npm-wired) that proves the precompile answers on a given RPC — useful
when de-risking a new chain/RPC endpoint.

Contract changes require `npm run prebuild` before `npm run sim` or `npm run dev`, since
`lib/abi.js` (imported by the app and by `lib/chain.mjs`) is generated from
`contracts/GroundTruth.sol` and is not source of truth.

Required env (see `.env.example`): `RPC_URL`/`NEXT_PUBLIC_RPC_URL` (Monad testnet, chain id
10143), `SPONSOR_PRIVATE_KEY` (testnet-only burner key that pays gas for every attendee — the
whole point is attendees never hold a wallet), `NEXT_PUBLIC_REGISTRY_ADDRESS`. `npm run sim`
writes the deployed address to `.address` (gitignored); `lib/chain.mjs#address()` falls back
to reading that file when `NEXT_PUBLIC_REGISTRY_ADDRESS` isn't set. Passkeys require HTTPS on
a real hostname — `localhost` won't get real WebAuthn credentials from a phone, so the actual
demo target is a Vercel deployment (`vercel.json` sets per-route `maxDuration`).

## Architecture

**Contract (`contracts/GroundTruth.sol`)** — one file, no ownership/upgrade path. Core flow:
- `enrol(x, y, proof)` — trust-on-first-enrol: anyone can register a P-256 public key as long
  as they can produce a valid signature over it (proof of possession), no admin gate.
- `commitBatch(Attestation[])` — the only way readings get written. It **never reverts** on a
  bad attestation; each element is checked independently (unknown device / revoked / stale
  counter / bad signature) and emits `Rejected(reason)` or `Committed(...)`, so a hostile
  batch and honest readings can be submitted together and the room sees named refusals
  instead of one failed transaction.
- Per-device `lastCounter` is the replay defense: `counter` must be strictly greater. It is
  deliberately *not* chosen by the reporter — `/api/attest` derives it from on-chain
  `lastCounter + 1` (a sequence number the reporter picks is not a sequence number).
- `_score` is the anti-Sybil-farming mechanism: trust rises when the tapped `opinion` agrees
  with the hardware-measured `grade`, falls hard when they disagree — so lying costs
  reputation whether or not the sensor lied too.
- Signature verification path: DER signature -> `_derToRS` (hand-rolled DER parser, no
  library) -> `_p256` staticcalls precompile `0x0100` with `(hash, r, s, x, y)`. The signed
  hash is the WebAuthn shape: `sha256(authenticatorData || sha256(clientDataJSON))`, not a
  hash of the payload directly — this is what makes real phone passkeys and the Node-based
  test/mock attestations (`lib/attest.mjs`) interchangeable inputs to the same contract path.
- `Cell` (one of 24 venue zones) is a single aggregate storage slot (`n`, `gradeSum`,
  `opinionSum`, `worst`) updated per accepted attestation — the map is chain *state*, not
  something rebuilt from logs.

**`lib/chain.mjs`** — the sponsor wallet's interface to the chain, used only from API routes
(Node runtime). Key constraints baked in here, all Monad-specific:
- Two txs from the same wallet always conflict (nonce is state, not a queue) → all sends are
  serialized through a promise-chain lock (`withLock`), one in flight at a time.
- viem's own retry is disabled everywhere (`retryCount: 0`) because a retry re-prepares the
  request and would broadcast a second tx with a second nonce; re-sends instead replay the
  *identical* signed bytes (`broadcast()`), and duplicate-broadcast errors are treated as
  success, not failure.
- `send()` signs then broadcasts (so a tx hash exists before the network answers), waits for
  a receipt up to `wait` ms, and returns `{ pending: true }` rather than throwing if the
  receipt doesn't show up in time — the caller (an API route) hands the hash back to the
  client, which polls `/api/receipt`.

**API routes (`app/api/*/route.js`)**, all `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`:
- `enrol` — verifies the signature cheaply in Node (`verifySig`, Node's own `crypto`, no
  chain call) before spending gas on `enrol()`.
- `attest` — same cheap pre-check, then reads the device's `lastCounter` to compute the next
  counter itself (the client never supplies it) and submits a single-element `commitBatch`.
  Uses the contract's `isCommitted` view as a dedupe check before resubmitting.
- `state` — the one endpoint both the attendee page and `/venue` poll. Reads all 24 cells +
  three counters in **one Multicall3 call** (`0xcA11bde...CA11`, canonical on Monad), plus a
  short `eth_getLogs` window for the "recent" ticker — capped at ~100 blocks because **the
  public RPC refuses wider `eth_getLogs` ranges**, which is exactly why the map itself is
  read from contract state and not rebuilt from logs. Has a 3-second in-process cache shared
  across pollers.
- `attack` — the stage "run the attacker" button: walks back through `eth_getLogs` pages to
  find a real committed device, then crafts a replay / unregistered-key / forged-signature
  triple via `lib/attest.mjs` and submits them through `commitBatch` directly (bypassing the
  API's own cheap pre-checks), so refusals shown are the contract's, not the app's politeness.
- `receipt` — polled by the client after a `pending` response; kept separate from `attest` so
  a slow block never turns a serverless function invocation into a long-lived one.
- `ping` — fixed-size (8 B or 200 KB with `?big=1`) no-store endpoint the browser times
  itself against to derive latency/jitter/downlink (browsers can't read RSSI).
- `qr` / `diag` — QR code for the join URL; a fire-and-forget diagnostic logger so a passkey
  failure on a stranger's phone still leaves a message in the deploy log.

**`lib/attest.mjs`** — fabricates WebAuthn-shaped P-256 attestations (Node `crypto`, same
curve/encoding as a real phone) used by tests, `script/mock_phone.mjs`, `script/deploy_demo.mjs`,
and the `attack` API route. This is what lets the contract's real signature-verification path
be exercised without any phone in the loop.

**`lib/passkey.js`** — the only browser-side crypto/WebAuthn code. Includes a small
hand-written CBOR decoder (`decode`/`head`) used to extract the P-256 x/y coordinates from
whatever shape a given phone's passkey hands back (bare COSE_Key, full attestationObject, or
raw authenticatorData) — written out explicitly rather than byte-scanned because vendors
disagree on the shape and a scan would hide that disagreement instead of surfacing it in the
error message. Also owns `enrol()`, `sign()`, and the client-side network `measure()` that
produces the `grade` (0..3) baked into every signed attestation.

**`lib/zones.js`** — the single source of truth for the 24-zone (6×4) grid over the venue
(CIC Berlin coordinates hardcoded as `CENTRE`). Shared by the attendee page (zone selection
from geolocation) and the `/venue` globe (drawing the same rectangles) — a zone id
(`cellHex`) is the *only* location information that ever reaches the chain.

**`app/`** — `page.jsx` is the attendee flow (enrol → geolocate-to-zone → measure → sign →
`/api/attest`); `venue/page.jsx` is the MapLibre-based projector globe reading `/api/state`;
`venue/flat/page.jsx` is a dependency-free 2D fallback view for when tiles don't load on
venue wifi.

## Things to know before changing code here

- Any change to the `Attestation` struct or contract signature verification must stay in
  sync across four places: `contracts/GroundTruth.sol`, `lib/attest.mjs` (test/mock
  fabrication), `lib/passkey.js` (real browser signing), and the API routes that assemble the
  struct before calling `send()`.
- `lib/abi.js` is generated — re-run `npm run prebuild` after any Solidity change, don't hand-edit it.
- Gas/cost numbers in `README.md` and `docs/PITCH.md` come from real testnet runs
  (`npm run sim` / production); don't restate them from memory if the contract changes —
  regenerate by rerunning the sim.

## Decisions 2026-09-26

- **No contract changes and no redeploy.** The live contract is
  `0x01dab65ecd7CE158c131c69ef8347e883118F55F` on Monad testnet (chain 10143) and must stay
  that way. Don't edit `contracts/GroundTruth.sol`, and don't run anything that deploys it.
- **Production is the only target.** The only URL is https://ground-truth-zeta.vercel.app.
  Passkeys are bound to the domain, so a preview URL would register credentials that don't
  work in production. Deploy every change to production, never to a preview.
- **Never show a made-up number on screen.** If a value wasn't measured, leave it out. Don't
  display a placeholder or default in its place.
- **The attendee flow is one tap.** Enrol and attest happen together in one batch. There is
  no separate enrol screen and no form.
- **The venue is CIC Berlin at 52.4940, 13.4463.** This is also the fallback location
  (`lib/zones.js` `CENTRE` / `HOME_ZONE`).
- **The repo must never contain the author's name or employer email** in any file. The
  existing GitHub noreply commit email is accepted.
