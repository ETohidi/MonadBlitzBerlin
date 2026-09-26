# Ground Truth — a map with no owner

Every map of a place has an owner, and the owner can edit it. Coverage maps are the plainest case: the company that sells the network also publishes the map of how good it is. Today we built the other kind. A phone signs two things together inside its secure element: what the person says about the network where they are standing, and what the phone measured at that moment. A contract on Monad checks the signature and adds the reading to the map, and the map is the contract's own storage, not a database behind a website. It runs at https://ground-truth-zeta.vercel.app (the projector view is /venue) against contract 0x01dab65ecd7CE158c131c69ef8347e883118F55F on Monad testnet, chain 10143.

## What the chain proves, and what it doesn't

It proves who signed a reading. The signature comes from a P-256 key that the phone's secure element will not export, and the contract checks it against the key that device enrolled with. It proves each reading counts once, because every device has a counter the contract only lets go up, so a replay is refused and a missing reading shows up as a gap. And it proves nobody changed a reading afterwards: there is no function that edits or deletes one.

It does not prove the measurement is true. The browser measures latency, jitter and downlink and the phone signs whatever it got. Someone in control of their own phone can sign a made-up measurement just as easily.

Our relay pays the gas and submits for everyone, so it can delay a reading or drop it. It cannot write a reading nobody signed, and it cannot change the zone, the opinion or the measurement of one that was signed. Before sending, it rebuilds the exact bytes the phone signed from the values it is about to write, and refuses the submission if they differ.

On chain are the opinion, the measured grade, the zone and a hash of the full signed reading. The raw latency, jitter and downlink numbers are not. The map needs only the grade, and every extra field would cost gas on every tap. The hash is there so that whoever holds the raw numbers can show later that they are the ones that were signed. It also means the chain on its own cannot confirm that a signature covers the values stored next to it. That check happens in the relay.

## How a tap becomes chain state

The QR code on the projector opens a page with the building's 24 zones and three buttons: poor, ok, excellent. The page measures the network in the background while it is open, so a tap goes straight to the Face ID or fingerprint prompt instead of waiting on a download first. On a phone that has never been here, the tap creates a passkey, reads its public key and then signs the reading, which is one tap and two prompts. The signed reading holds the device's next counter, the zone, the opinion, the measurement and a timestamp. The relay checks the signature in Node, checks that it covers exactly those values, and sends a transaction. For a new phone that transaction goes through Multicall3 and carries both the enrolment and the reading, so a first tap is on the map in a single block. After that every tap is one call to commitBatch, which verifies the signature on chain, moves the counter, adjusts the device's trust and adds the reading to its zone's totals. The phone shows "sent" as soon as the relay has the reading and the block number once the receipt comes back.

## Three things about Monad that shaped the design

The public RPC answers eth_getLogs for at most 100 blocks, about 30 seconds at the block times we saw. Our first map was rebuilt from events, and it forgot the room half a minute after people stopped tapping. We moved the map into contract storage instead. Each zone keeps a count and running sums in one slot, and the projector reads all 24 zones in one Multicall3 call. Events now only feed the ticker of the last few seconds.

Two transactions from the same wallet conflict on Monad, because the nonce is state rather than a queue. With one sponsor wallet paying for everyone, we could not fire a transaction per request in parallel. The relay sends one at a time. When a send times out it re-broadcasts the identical signed bytes rather than letting the client library sign again with a fresh nonce, which would have paid twice. commitBatch takes an array and never reverts on a bad entry. Each entry comes back accepted or refused with a reason, which is why a batch of attacks can go in next to honest readings and the refusals are visible.

P-256 verification is a precompile on Monad, EIP-7951 at address 0x0100, at a fixed 6,900 gas. Passkeys sign with P-256, so the contract checks a phone's own signature directly. There is no wallet, no key the attendee has to look after, and no account abstraction layer in between. Before writing anything else we checked that the precompile answers on testnet (script/p256_probe.mjs). A valid signature returns 1 and a tampered hash returns nothing.

## Numbers, measured today on the testnet

- P-256 verification: 6,900 gas, the precompile's fixed price. A bare call to it estimated at 30,799 gas, which includes the 21,000 transaction base and the calldata.
- One attestation on its own: 169,542 to 170,431 gas per transaction across eleven single commits, plus one at 149,023.
- Five attestations in one batch: 542,918 gas for the transaction, 108,583.6 each, or 104,383.6 each if the 21,000 base is left out.
- Enrolment on its own: 157,182 to 157,674 gas. The very first enrolment on the fresh contract took 177,916.
- A new phone's first tap, enrolment and reading together in one Multicall3 transaction: 295,850 gas, measured once.
- Reading the whole map, 24 zones in one Multicall3 call: 28 ms median over eight calls from our laptop.
- Block time: 0.311 s on average over the 32,806 blocks between our deployment and 16:42 today.
- Try to cheat, pressed four times: each press sends a replayed reading, a reading from a key that never enrolled and a forged signature over a real device, all in one transaction. All twelve came back refused (stale counter, unknown device, bad signature), at 126,853 to 127,092 gas per press.
- Trust: every device starts at 1000. A tap that matches the measured grade adds 25, one step off adds 5, and each further step costs 120. On chain today that took one device from 1025 to 665 for tapping excellent over a measured unusable, and a new device from 1000 to 760 for tapping unusable over a measured ok.
- The contract is 4,923 bytes deployed, with no constructor, no owner and no upgrade path. At the time of writing it holds 20 accepted readings, 15 refusals and 16 devices.

## Trust model

The measurement is self-reported. The phone runs the probes and signs the result, and nothing on chain can tell a real 40 ms from a typed-in one. What we can do is make a claim cost something. Trust rises when what a person taps agrees with what their own phone measured, and it falls fast when a confident claim contradicts it. A phone that reports excellent from a dead corner pays for it in public.

Against a phone that lies consistently, measurement and opinion both, the defence is redundancy. Other devices report from the same zone at the same time, and a buyer of the data re-measures before relying on it.

Enrolment is trust on first use. Any key that can sign for itself can register. We do not check Apple's or Google's attestation chains, so the contract knows a passkey, not a person, and one person with three devices is three reporters.

There is no reward for reports. A reward would give people a reason to send more of them, and volume is exactly what an attacker can produce cheaply. We would rather the score be something a buyer weights readings by than something a reporter farms.

## What is not proven

The map colours are an unweighted mean of taps. Trust exists per device, but the zone totals in storage carry no weights, so the colours ignore it.

The check that a signature covers the stored values happens in our relay, not in the contract, and the raw measurements are not kept anywhere yet. So at the moment nobody except the relay, at the moment of submission, can confirm that a reading's hash matches its numbers.

The contract's revoke function has no access check, so anyone can revoke any device. We found it tonight. Fixing it needs a new deployment, which we ruled out for the demo.

The zones were fitted by eye to satellite imagery, and they are smaller than phone GPS can resolve. The phone suggests a zone and the person picks one.

Some readings on the contract came from our rehearsal scripts, signed with keys generated in Node rather than by phones.

The one-tap first enrolment has landed on chain once. We have not yet had a room full of phones on it.

## Running it

Copy .env.example to .env.local and set RPC_URL to a Monad testnet endpoint, SPONSOR_PRIVATE_KEY to a burner key funded from the testnet faucet, and NEXT_PUBLIC_REGISTRY_ADDRESS to the contract above. Then:

```bash
npm ci
npm run prebuild   # compiles the contract with solc-js and writes lib/abi.js
npm test           # the passkey key parser against every shape we have seen
npm run dev
```

Passkeys need HTTPS on a real hostname, so phones have to use the deployed site. script/mock_phone.mjs refuses to run unless ALLOW_MOCK=1 is set, and refuses to point at the production relay. npm run sim deploys a new contract whenever the build changes, and it is switched off for now. Everything here is testnet only, and the sponsor key should never hold anything of value.
