export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { decodeEventLog } from 'viem';
import { pub, address, abi } from '../../../lib/chain.mjs';

const WINDOW = 900n; // ~4.5 minutes of 0.3s blocks

export async function GET() {
  if (!address()) return NextResponse.json({ ok: false, error: 'no contract' }, { status: 500 });
  const head = await pub.getBlockNumber();
  const from = head > WINDOW ? head - WINDOW : 0n;
  const logs = await pub.getLogs({ address, fromBlock: from, toBlock: head });

  const cells = {};
  let accepted = 0; let rejected = 0;
  const devicesSeen = new Set();
  for (const l of logs) {
    let ev;
    try { ev = decodeEventLog({ abi, data: l.data, topics: l.topics }); } catch { continue; }
    if (ev.eventName === 'Committed') {
      accepted++;
      devicesSeen.add(ev.args.deviceId);
      const idx = parseInt(ev.args.cell.slice(64), 16);
      const c = (cells[idx] ??= { n: 0, grade: 0, opinion: 0, worst: 3, last: null });
      c.n++; c.grade += ev.args.grade; c.opinion += ev.args.opinion;
      c.worst = Math.min(c.worst, ev.args.grade);
      c.last = { opinion: ev.args.opinion, grade: Number(ev.args.grade), trust: String(ev.args.trust) };
    } else if (ev.eventName === 'Rejected') rejected++;
  }

  const [totalAccepted, totalRejected, block, oldest] = await Promise.all([
    pub.readContract({ address, abi, functionName: 'totalAccepted' }),
    pub.readContract({ address, abi, functionName: 'totalRejected' }),
    pub.getBlock({ blockNumber: head }),
    pub.getBlock({ blockNumber: from }),
  ]);
  const span = Number(block.timestamp - oldest.timestamp);
  const blocks = Number(head - from) || 1;

  return NextResponse.json({
    ok: true, head: String(head), accepted, rejected, totalAccepted: String(totalAccepted),
    totalRejected: String(totalRejected), devices: devicesSeen.size,
    secondsPerBlock: (span / blocks).toFixed(2), cells,
  });
}
