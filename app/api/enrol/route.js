export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { verifySig, send, deviceOf, deviceIdOf, address } from '../../../lib/chain.mjs';

export async function POST(req) {
  if (!address()) return NextResponse.json({ ok: false, error: 'contract not deployed' }, { status: 500 });
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'bad json' }, { status: 400 }); }
  const { x, y, proof } = body;
  try {
    const deviceId = deviceIdOf(x, y);
    if (!proof || !verifySig(x, y, proof)) {
      return NextResponse.json({ ok: false, deviceId, error: 'proof signature does not verify' }, { status: 400 });
    }
    const d = await deviceOf(deviceId);
    // bytes32 decodes to a hex string, so compare numerically: `x !== 0n` is always true.
    if (BigInt(d.x) !== 0n) return NextResponse.json({ ok: true, exists: true, deviceId, trust: String(d.trust) });
    // The contract takes the whole Attestation struct; a browser proves possession with the
    // three signature fields and nothing else, and enrol() reads nothing else.
    const a = { deviceId, counter: 0n, opinion: 0, grade: 0, cell: '0x' + '00'.repeat(32), payloadHash: '0x' + '00'.repeat(32), ...proof };
    const r = await send('enrol', [x, y, a], { wait: 25_000 });
    if (!r.rc) return NextResponse.json({ ok: true, pending: true, deviceId, tx: r.hash });
    return NextResponse.json({
      ok: r.rc.status === 'success', deviceId, tx: r.hash,
      gasUsed: String(r.rc.gasUsed), costMono: r.costMono, block: String(r.rc.blockNumber),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e.shortMessage ?? e.message) }, { status: 500 });
  }
}
