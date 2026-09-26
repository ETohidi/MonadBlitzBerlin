# Ground Truth — the room is the sensor network

Scan a QR code, tap how the network feels where you are standing. Your phone also measures
the network — latency, jitter, downlink — and signs **both** the claim and the measurement
with a key inside its secure element. A contract on Monad verifies that signature with the
P-256 precompile and writes the reading down. The projector shows a map of the venue being
built by the venue, and a running count of the attacks the chain just refused.

## Why this needs a chain at all

Coverage and QoE data today is either self-reported with no provenance, or sold by the vendor
who has an interest in it. Every serious attempt at "trustworthy data exchange" in data spaces
has retreated from *settlement* to *tamper-evident receipts* — the IDS Clearing House, the piece
that used to notarise and settle data usage, was archived read-only in June 2025. That is the
honest state of the art: what a buyer of shared measurements needs first is not a payment
rail, it is evidence that the measurement existed, when, and from whom.

So the chain is deliberately **not in the control loop**. 0.3-second blocks are already far too
slow for a radio decision, and nothing about congestion control belongs on a ledger. The chain is
the *accountability layer* — the record that is disputed later.

## What each attestation proves

| property | mechanism |
| --- | --- |
| authorship | a P-256 signature from a non-exportable platform key, verified at `0x0100` |
| not written after the fact | a monotonic per-device counter; a hole in it is visible as a hole |
| nobody edits the record | append-only commitments, indexed by device + counter + payload hash |
| the map is not an opinion | per-zone aggregates live in contract storage, not in a cache |
| claiming is costly | trust rises when the tap agrees with the device's own measurement, falls when a confident claim is contradicted |

The last row is the answer to reward farming. There is nothing to volume-mine: a redundant or
dishonest reading costs the reporter their trust score, and the score is what any future buyer
of this record would weight it by.

## Numbers measured on Monad testnet (chain 10143, 26 Sep 2026)

- P-256 signature verification: **6,900 gas** (EIP-7951 precompile, one staticcall)
- one attestation alone: **169k gas** — 5 batched into one transaction: **≈104k each**
- the full scripted demo run — 3 enrolments, 7 accepted readings, 3 refusals — cost **0.14 MON**; deploying the contract cost another 0.14
- block time during the session: **0.30–0.34 s**
- contract: one file, ~4.9 KB, 0 warnings, no constructor, no ownership, no upgrade path

## What the stage demo attacks, on chain

Four hostile submissions go into one `commitBatch` in front of the audience:

1. **replay** — yesterday's reading, resubmitted → `Rejected(StaleCounter)`
2. **ghost key** — a valid signature from a key that was never enrolled → `Rejected(UnknownDevice)`
3. **forgery** — a signature made by the wrong key over a registered device id → `Rejected(BadSignature)`
4. **confident lie** — the phone measured the worst grade, the human tapped "excellent" → accepted, trust 1025 → **665**

`commitBatch` never reverts: a refusal is a result, and a result the room can see is worth more
than a reverted transaction. The negative control runs the other way — a tampered DER signature
on `enrol` *must* revert, and the deploy script fails the build if it doesn't.

## Trust model, stated plainly

**What the chain proves:** who signed, that they signed it once, and that nobody can edit or
backdate it afterwards.
**What it does not prove:** that the radio measurement was truthful. The measurement is
self-reported into the signature, so a determined reporter can lie *consistently* — grade and
opinion both fabricated. The defence is redundancy: independent devices in the same zone at the
same time, and a buyer who re-measures. That is exactly the assumption GEODNET gets away with,
and the same limit it has.
**Sybil:** one passkey is one device, not one person. Apple/Android key-attestation chains would
close this and are deliberately not validated here — enrolment is trust-on-first-enrol, proved by
a signature from the key being registered.
**The sponsor** pays the gas and can delay or censor a submission. It cannot forge one, because
authorship travels in the device signature.
**Attendees** never install a wallet, never hold a key onchain, and never give a precise
position: a coarse zone, one tap, and only the public half of a key pair.

## Run it

```bash
npm ci
npm run prebuild                 # solc-js -> out/*.abi.json, out/*.bin, lib/abi.js
npm run sim                      # deploy + full assertion suite against testnet, ~30s
npm run dev                      # http://localhost:3000  (attendee)  /venue  (projector)
node script/mock_phone.mjs http://127.0.0.1:3000 8   # scripted attendees, no phones needed
```

Deploy it publicly — passkeys require HTTPS on a real hostname, and a locally hosted demo is
disqualified anyway:

```bash
npx vercel          # env: RPC_URL, SPONSOR_PRIVATE_KEY, NEXT_PUBLIC_REGISTRY_ADDRESS
```

`SPONSOR_PRIVATE_KEY` is a testnet-only burner, minted from <https://faucet.monad.xyz>.
`.address` is written by `npm run sim`; set `NEXT_PUBLIC_REGISTRY_ADDRESS` to the same value in
the deployed app, since the file is gitignored.

## Layout

```
contracts/GroundTruth.sol   devices, cells, commitments, batch commit, scoring
lib/attest.mjs              WebAuthn-shaped attestation factory (Node, same curve and encoding)
lib/passkey.js              browser side: enrol, sign, measure; reads the COSE key without a CBOR dep
lib/chain.mjs               sponsor: sign-then-broadcast, serialised, bounded receipt wait
app/                        attendee page, venue projector, /api/{enrol,attest,state,receipt,attack,qr,ping}
script/compile.mjs          solc-js wrapper            (no Foundry install needed to build)
script/p256_probe.mjs       the de-risking proof: does precompile 0x0100 answer on Monad?
script/deploy_demo.mjs      deploy + assertions, exits non-zero if any claim fails
script/mock_phone.mjs       replay mode for an empty room or dead wifi
```

Three Monad-specific things that shaped the design:

- **Two transactions from the same wallet always conflict** (the nonce is state, not a queue),
  so the sponsor batches many attestations into one `commitBatch` and serialises sends per instance.
- **The public RPC caps `eth_getLogs` at a 100-block range** — about 30 seconds — which is why the
  map lives in contract storage and logs are only the last-minute ticker.
- **P-256 is a native precompile**, which is the only reason a per-tap hardware signature is
  affordable at 6,900 gas.
