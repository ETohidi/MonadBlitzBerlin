export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The presenter's "attacker" button. It submits three hostile attestations straight to
// the chain, bypassing the server's cheap pre-checks, so the refusal the room sees is the
// contract's — not the app's. Without this the demo only proves the app is polite.
import { NextResponse } from 'next/server';
import { decodeEventLog } from 'viem';
import { pub, send, deviceOf, address, abi } from '../../../lib/chain.mjs';
import { newDevice, attest } from '../../../lib/attest.mjs';

export async function POST() {
  const to = address();
  if (!to) return NextResponse.json({ ok: false, error: 'no contract' }, { status: 500 });

  // The public RPC answers eth_getLogs for at most 100 blocks, so walk back a few
  // windows until we find a device that really is on the record.
  const head = await pub.getBlockNumber();
  let target = null;
  for (let page = 0; page < 10 && !target; page++) {
    const high = head - BigInt(page * 100);
    const low = high > 100n ? high - 100n : 0n;
    const logs = await pub.getLogs({ address: to, fromBlock: low, toBlock: high });
    for (let i = logs.length - 1; i >= 0; i--) {
      try {
        const ev = decodeEventLog({ abi, data: logs[i].data, topics: logs[i].topics });
        if (ev.eventName === 'Committed') { target = { id: ev.args.deviceId, counter: Number(ev.args.counter) }; break; }
      } catch { /* ignore */ }
    }
  }
  if (!target) return NextResponse.json({ ok: false, error: 'no attested device in the last few minutes — tap once on a phone, then retry' }, { status: 400 });

  const cell = '0x' + '0'.repeat(64);
  const signedWithWrongKey = newDevice();
  const ghost = newDevice();
  const d = await deviceOf(target.id);

  const stale = { ...attest(signedWithWrongKey, { counter: target.counter, opinion: 3, grade: 3, cell }), deviceId: target.id, counter: BigInt(target.counter) };
  const unregistered = attest(ghost, { counter: 1, opinion: 0, grade: 0, cell });
  const forged = { ...attest(signedWithWrongKey, { counter: BigInt(target.counter) + 1n, opinion: 3, grade: 3, cell }), deviceId: target.id, counter: BigInt(target.counter) + 1n };

  const r = await send('commitBatch', [[stale, unregistered, forged]]);
  const REASON = ['Accepted', 'unknown device', 'revoked device', 'stale counter — replay', 'bad signature'];
  const refused = [];
  for (const l of r.rc.logs) {
    try {
      const ev = decodeEventLog({ abi, data: l.data, topics: l.topics });
      if (ev.eventName === 'Rejected') refused.push(REASON[Number(ev.args.reason)] ?? 'rejected');
    } catch { /* ignore */ }
  }
  return NextResponse.json({
    ok: true, refused, tx: r.hash, gasUsed: String(r.rc.gasUsed), costMono: r.costMono,
    note: `device under attack lastCounter=${d.lastCounter} trust=${d.trust} — nothing was written`,
  });
}
