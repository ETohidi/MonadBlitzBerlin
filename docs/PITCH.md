# Pitch — Ground Truth

Not part of the build. A talk track plus the questions to expect.

## 60 seconds

Coverage data is the one dataset everyone contributes to and nobody trusts. Crowdmaps are
self-reported with no provenance; operator maps are marked homework by the vendor selling them.
Ground Truth is the accountability layer for a measurement you can check with your own phone:
scan a QR, tap how the network feels, and your phone signs that claim *together with* what it
actually measured — with a key inside its secure element that cannot be exported. Monad verifies
each signature in the EVM at 6,900 gas and appends the reading. The map on this screen is being
built right now by the people in this room, and the chain refuses replays, ghost devices and
forged signatures on camera.

## 3 minutes, beat by beat

**0:00 — the hook, live.** "Everyone take out your phone and scan this." While phones come out,
say the sentence above. Nothing on the screen yet.

**0:40 — what just happened on a single tap.** Point at the attendee phone: the passkey sheet,
one tap for a zone, one tap for an opinion. "No wallet, no seed phrase, no MON, no download. That
face-unlock is a signature over a P-256 key that Apple and Google's hardware says never left the
device."

**1:20 — the map, and the number.** Read the counters off the projector: devices, attestations,
refusals, block time. "Six thousand nine hundred gas to verify a hardware signature — that is why
this is per tap and not per packet. And 0.3-second blocks mean the room sees itself."
Say plainly: the chain is **not** in the control loop. Nothing here should steer a radio. It is the
record that gets disputed later.

**1:50 — the attacks.** Press `Try to cheat`. Four hostile submissions go in as one batch:
yesterday's reading replayed, a valid signature from a key nobody ever enrolled, a signature made
by the wrong key over someone else's device id, and a confident lie — a phone that measured the
worst grade while the human tapped "excellent". Three come back refused with a reason. The lie is
*accepted*, and its device's trust drops from 1025 to 665, on chain, in the open.

**2:20 — why the scoring is the point.** "A reputation system you can farm is worse than none. Here
agreement between what you claimed and what your own hardware measured raises your score; a
confident claim contradicted by your own sensor lowers it. So there is nothing to mine by volume —
redundant and dishonest readings cost the reporter."

**2:40 — the honest limits and the trajectory.** "One passkey is one device, not one person; the fix
is Apple and Android key-attestation chains, which we deliberately did not validate in a day. And a
reporter can lie consistently about their own measurement — the defence is independent devices in
the same zone, and a buyer who re-measures. That is the same assumption GEODNET runs on."

## Prior art — and the gap each one leaves

| | what it proves | what it does not |
| --- | --- | --- |
| GEODNET | machine-verified RTK observations, real revenue (~$8M/yr) | low-privacy, standardised sensor; no human claim involved |
| WeatherXM / Helium | people earn for hosting hardware | reward *presence*, not the truth of a reading; both fought spoofing for years |
| Hivemapper / DIMO | camera and CAN evidence, priced per mile/km | the reporter's device is not attested per reading |
| OpenSignal, rootmetrics | drive-test QoE maps | vendor-run, opaque method, no per-measurement provenance |
| OpenCellID, Mozilla ICSM | community willingness to map cells at scale | ICSM was switched off in 2024 — the hosted version does not outlive its host; no per-reading authorship |
| IDS / Gaia-X receipts | notarised usage policies | the settlement leg was archived read-only in June 2025 — the field retreated to evidence |

The gap: nobody has made an ordinary phone's **secure element** the signing authority for a
claim-plus-measurement pair, at a gas cost that permits one signature per tap. Monad makes that
affordable because EIP-7951 verification is native to the EVM here.

## Questions judges ask, and the answer

**"Why does this need a blockchain?"** So that the record survives the party who would benefit from
editing it. A central map could implement all of this and then quietly rewrite last month. The
properties being bought are non-repudiation and a public ordering, and both are checkable by anyone
afterwards.

**"Isn't the phone just lying for the reward?"** There is no reward in this build — that is on
purpose. What exists is a cost function that makes lying about your own measurement expensive in
reputation. Payment is downstream of the reputation, not the other way around.

**"Anyone can enrol a thousand devices."** Yes, in a day. One passkey is one device. The two-step fix
is platform attestation chains, then rate-limiting enrolment per zone per hour. Sybil resistance is
the honest open problem, and it is why the demo shows refusals rather than pretending immunity.

**"What did you actually write?"** One Solidity file (~4.9 KB, no ownership, no upgrade), a browser
passkey client that reads the COSE key without a CBOR dependency, a sponsor that batches and
serialises submissions, and a projector view that reads the map from contract storage. Plus the
probe that proved the precompile answers on Monad before anything else was written.

**"Where does it go?"** Two directions. Deep: verify Apple/Android attestation chains so a device is
tied to a person, then let an operator or a spectrum buyer query per-zone aggregates against the raw
public signatures. Wide: the same object — *a signed claim-plus-measurement pair* — is what a
sensor-fleet SLA, a carbon-footprint claim, or an insurance photo needs. This build is the primitive,
with the venue as the test bed.

## Stage logistics

- Projector: `/venue`. Phones: `/` behind the QR on that page.
- No wifi for the room? `node script/mock_phone.mjs <url> 8` drives the same endpoints through a
  Node P-256 key, so the map and the attacks still run live.
- If the RPC stalls, `npm run sim` output from the last successful run has every number in this
  pitch, and each attestation links to `testnet.monadscan.com`.
