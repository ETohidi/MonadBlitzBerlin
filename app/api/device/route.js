export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The phone fetches its next counter before the tap, because the counter is inside what it signs.
import { NextResponse } from 'next/server';
import { deviceOf, address } from '../../../lib/chain.mjs';

export async function GET(req) {
  if (!address()) return NextResponse.json({ ok: false, error: 'contract not deployed' }, { status: 500 });
  const id = new URL(req.url).searchParams.get('id');
  if (!id || !/^0x[0-9a-fA-F]{64}$/.test(id)) return NextResponse.json({ ok: false, error: 'bad id' }, { status: 400 });
  try {
    const d = await deviceOf(id);
    const known = BigInt(d.x) !== 0n;
    return NextResponse.json({ ok: true, known, next: String(d.lastCounter + 1n) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e.shortMessage ?? e.message) }, { status: 500 });
  }
}
