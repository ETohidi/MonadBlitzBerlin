export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';

/// A passkey failure happens on someone else's phone, once, in front of an audience.
/// The message is shown on screen; this puts the same bytes in the deploy log, so the
/// diagnosis does not depend on a stranger reading a hex dump aloud.
export async function POST(req) {
  const b = await req.json().catch(() => null);
  if (b?.stage && typeof b.message === 'string') {
    console.log('[passkey-diag]', String(b.stage).slice(0, 16), '|', String(b.ua ?? '').slice(0, 160), '|', b.message.slice(0, 2000));
  }
  return NextResponse.json({ ok: true });
}
