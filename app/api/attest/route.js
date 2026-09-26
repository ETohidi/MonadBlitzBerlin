export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { keccak256, toBytes, decodeEventLog, encodeFunctionData, multicall3Abi } from 'viem';
import crypto from 'node:crypto';
import { verifySig, send, deviceOf, deviceIdOf, address, abi, MULTICALL3 } from '../../../lib/chain.mjs';
import { readingJSON } from '../../../lib/reading.js';
import { N } from '../../../lib/zones.js';

export async function POST(req) {
  const to = address();
  if (!to) return NextResponse.json({ ok: false, error: 'contract not deployed' }, { status: 500 });
  let b;
  try { b = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'bad json' }, { status: 400 }); }
  const { deviceId, opinion, grade, cell, lat, jitter, down, ts, sig, x, y } = b;
  const level = (v) => Number.isInteger(v) && v >= 0 && v <= 3;
  const zone = /^0x[0-9a-f]{64}$/i.test(String(cell)) ? Number(BigInt(cell)) : -1;
  if (!level(opinion) || !level(grade) || !(zone >= 0 && zone < N)
    || ![lat, jitter, down, ts].every(Number.isFinite) || !/^0x[0-9a-f]{64}$/i.test(String(deviceId)) || !sig?.clientDataJSON) {
    return NextResponse.json({ ok: false, reason: 'malformed reading' }, { status: 400 });
  }
  try {
    const d = await deviceOf(deviceId);
    // bytes32 decodes to a hex string, so compare numerically: `x === 0n` is never true
    const known = BigInt(d.x) !== 0n;
    // A first tap carries its public key, and its signature doubles as the enrolment proof.
    if (!known && !(x && y && deviceIdOf(x, y).toLowerCase() === String(deviceId).toLowerCase())) {
      return NextResponse.json({ ok: false, reason: 'unknown device and no key to enrol it with' }, { status: 400 });
    }
    // anyone can revoke any device on this contract; the phone answers with a fresh passkey
    if (known && d.revoked) return NextResponse.json({ ok: false, revoked: true, reason: 'device revoked' }, { status: 409 });
    if (!verifySig(known ? d.x : x, known ? d.y : y, sig)) {
      return NextResponse.json({ ok: false, reason: 'signature rejected before it cost anything' }, { status: 400 });
    }
    const counter = d.lastCounter + 1n;
    const reading = readingJSON({ deviceId, counter, opinion, grade, cell, lat, jitter, down, ts });
    // The contract only checks the signature over whatever clientDataJSON it is handed; the
    // binding between that signature and the values written next to it is checked here.
    let signed = null;
    try { signed = JSON.parse(Buffer.from(String(sig.clientDataJSON).slice(2), 'hex').toString('utf8')); } catch { /* refused below */ }
    const want = crypto.createHash('sha256').update(reading).digest('base64url');
    if (signed?.type !== 'webauthn.get' || signed.challenge !== want) {
      return NextResponse.json({ ok: false, reason: 'signature does not cover this reading, tap again' }, { status: 400 });
    }
    const payloadHash = keccak256(toBytes(reading));
    const att = { deviceId, counter, opinion, grade, cell, payloadHash, ...sig };
    const dedupe = [deviceId, counter, payloadHash];
    const r = known
      ? await send('commitBatch', [[att]], { dedupe })
      : await send('aggregate3', [[
        // allowFailure on enrol: a concurrent tap may have enrolled this key a block earlier
        { target: to, allowFailure: true, callData: encodeFunctionData({ abi, functionName: 'enrol', args: [x, y, att] }) },
        { target: to, allowFailure: false, callData: encodeFunctionData({ abi, functionName: 'commitBatch', args: [[att]] }) },
      ]], { target: MULTICALL3, targetAbi: multicall3Abi, dedupe, wait: 12_000 });
    if (r.deduped) {
      const now = await deviceOf(deviceId);
      return NextResponse.json({ ok: true, accepted: true, deduped: true, trust: String(now.trust), counter: String(counter) });
    }
    if (!r.rc) return NextResponse.json({ ok: true, pending: true, trust: String(d.trust), counter: String(counter), tx: r.hash });

    let trust = String(d.trust);
    let accepted = null;
    let revoked = false;
    for (const l of r.rc.logs) {
      try {
        const ev = decodeEventLog({ abi, data: l.data, topics: l.topics });
        if (ev.eventName === 'Committed') { accepted = true; trust = String(ev.args.trust); }
        if (ev.eventName === 'Rejected') { accepted = false; revoked = Number(ev.args.reason) === 2; }
      } catch { /* ignore */ }
    }
    return NextResponse.json({
      ok: accepted === true, accepted, revoked, trust, counter: String(counter), tx: r.hash,
      gasUsed: String(r.rc.gasUsed), costMono: r.costMono, block: String(r.rc.blockNumber),
      latency: Date.now() - ts,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e.shortMessage ?? e.message) }, { status: 500 });
  }
}
