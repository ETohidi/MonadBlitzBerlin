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

  // The attacker's claimed measurement: refused on chain before anything is written, never displayed.
  const claim = { lat: 1, jitter: 0, down: 999999 };
  const stale = { ...attest(signedWithWrongKey, { counter: target.counter, opinion: 3, grade: 3, cell, ...claim }), deviceId: target.id, counter: BigInt(target.counter) };
  const unregistered = attest(ghost, { counter: 1, opinion: 0, grade: 0, cell, ...claim });
  const forged = { ...attest(signedWithWrongKey, { counter: BigInt(target.counter) + 1n, opinion: 3, grade: 3, cell, ...claim }), deviceId: target.id, counter: BigInt(target.counter) + 1n };

  const r = await send('commitBatch', [[stale, unregistered, forged]], { wait: 40_000 });
  if (!r.rc) return NextResponse.json({ ok: false, error: `broadcast, not in a block yet: ${r.hash}` }, { status: 504 });
  const REASON = ['Accepted', 'UnknownDevice', 'Revoked', 'StaleCounter', 'BadSignature'];
  // commitBatch emits exactly one Committed or Rejected per element, in submission order
  const outcomes = [];
  for (const l of r.rc.logs) {
    try {
      const ev = decodeEventLog({ abi, data: l.data, topics: l.topics });
      if (ev.eventName === 'Rejected') outcomes.push(REASON[Number(ev.args.reason)] ?? 'Rejected');
      if (ev.eventName === 'Committed') outcomes.push('Accepted');
    } catch { /* ignore */ }
  }
  return NextResponse.json({
    ok: true, outcomes, refused: outcomes.filter((o) => o !== 'Accepted'), tx: r.hash, gasUsed: String(r.rc.gasUsed), costMono: r.costMono,
    note: `device under attack lastCounter=${d.lastCounter} trust=${d.trust} — nothing was written`,
  });
}
