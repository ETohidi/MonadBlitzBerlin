export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The client polls this after a tap. Keeping the wait here instead of inside
// /api/attest means a slow block never turns into a dead serverless function.
import { NextResponse } from 'next/server';
import { decodeEventLog } from 'viem';
import { pub, abi } from '../../../lib/chain.mjs';

const REASON = ['accepted', 'unknown device', 'revoked device', 'stale counter — replay', 'bad signature'];

export async function GET(req) {
  const hash = new URL(req.url).searchParams.get('tx');
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return NextResponse.json({ found: false, error: 'bad tx' }, { status: 400 });
  try {
    const rc = await pub.getTransactionReceipt({ hash });
    const out = {
      found: true,
      status: rc.status,
      gasUsed: String(rc.gasUsed),
      costMono: Number(rc.gasUsed * (rc.gasPrice ?? rc.effectiveGasPrice ?? 0n)) / 1e18,
      block: String(rc.blockNumber),
      tx: hash,
      events: [],
    };
    for (const l of rc.logs) {
      try {
        const ev = decodeEventLog({ abi, data: l.data, topics: l.topics });
        if (ev.eventName === 'Committed') {
          out.trust = String(ev.args.trust);
          out.accepted = true;
          out.events.push(`Committed opinion=${ev.args.opinion} grade=${ev.args.grade} trust=${ev.args.trust}`);
        } else if (ev.eventName === 'Rejected') {
          out.accepted = out.accepted ?? false;
          out.reason = REASON[Number(ev.args.reason)] ?? 'rejected';
          out.events.push(`Rejected — ${out.reason}`);
        } else if (ev.eventName === 'Enrolled') {
          out.enrolled = true;
          out.events.push('Enrolled');
        }
      } catch { /* unrelated log */ }
    }
    return NextResponse.json(out);
  } catch (e) {
    if (/not found|Invalid|unknown/i.test(e.shortMessage ?? e.message ?? '')) return NextResponse.json({ found: false });
    return NextResponse.json({ found: false, error: String(e.shortMessage ?? e.message) }, { status: 500 });
  }
}
