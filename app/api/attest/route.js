export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { keccak256, toBytes, decodeEventLog } from 'viem';
import { verifySig, send, deviceOf, address, abi } from '../../../lib/chain.mjs';

export async function POST(req) {
  if (!address()) return NextResponse.json({ ok: false, error: 'contract not deployed' }, { status: 500 });
  const b = await req.json();
  const { deviceId, opinion, grade, cell, lat, jitter, down, ts, sig } = b;
  try {
    const d = await deviceOf(deviceId);
    // bytes32 decodes to a hex string, so compare numerically: `x === 0n` is never true
    if (BigInt(d.x) === 0n) return NextResponse.json({ ok: false, reason: 'unknown device — enrol first' }, { status: 400 });
    if (!verifySig(d.x, d.y, sig)) {
      return NextResponse.json({ ok: false, reason: 'signature rejected before it cost anything' }, { status: 400 });
    }
    const counter = d.lastCounter + 1n;
    const payloadHash = keccak256(toBytes(JSON.stringify({ deviceId, counter: String(counter), opinion, grade, cell, lat, jitter, down, ts })));
    const att = { deviceId, counter, opinion, grade, cell, payloadHash, ...sig };
    const r = await send('commitBatch', [[att]], { dedupe: [deviceId, counter, payloadHash] });
    if (r.deduped) {
      const now = await deviceOf(deviceId);
      return NextResponse.json({ ok: true, accepted: true, deduped: true, trust: String(now.trust), counter: String(counter) });
    }
    if (!r.rc) return NextResponse.json({ ok: true, pending: true, trust: String(d.trust), counter: String(counter), tx: r.hash });

    let trust = String(d.trust);
    let accepted = null;
    for (const l of r.rc.logs) {
      try {
        const ev = decodeEventLog({ abi, data: l.data, topics: l.topics });
        if (ev.eventName === 'Committed') { accepted = true; trust = String(ev.args.trust); }
        if (ev.eventName === 'Rejected') accepted = false;
      } catch { /* ignore */ }
    }
    return NextResponse.json({
      ok: accepted === true, accepted, trust, counter: String(counter), tx: r.hash,
      gasUsed: String(r.rc.gasUsed), costMono: r.costMono, block: String(r.rc.blockNumber),
      latency: Date.now() - ts,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e.shortMessage ?? e.message) }, { status: 500 });
  }
}
