export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { verifySig, send, deviceOf, deviceIdOf, address } from '../../../lib/chain.mjs';

export async function POST(req) {
  if (!address()) return NextResponse.json({ ok: false, error: 'contract not deployed' }, { status: 500 });
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'bad json' }, { status: 400 }); }
  const { x, y, proof } = body;
  const deviceId = deviceIdOf(x, y);
  try {
    if (!proof || !verifySig(x, y, proof)) {
      return NextResponse.json({ ok: false, deviceId, error: 'proof signature does not verify' }, { status: 400 });
    }
    const d = await deviceOf(deviceId);
    if (d.x !== 0n) return NextResponse.json({ ok: true, exists: true, deviceId, trust: String(d.trust) });
    const r = await send('enrol', [x, y, proof]);
    return NextResponse.json({
      ok: r.rc.status === 'success', deviceId, tx: r.hash,
      gasUsed: String(r.rc.gasUsed), costMono: r.costMono, block: String(r.rc.blockNumber),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e.shortMessage ?? e.message) }, { status: 500 });
  }
}
