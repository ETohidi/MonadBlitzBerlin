export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { decodeEventLog } from 'viem';
import { pub, address, abi } from '../../../lib/chain.mjs';

// Multicall3 is canonical on Monad testnet and mainnet. One round trip reads the whole
// map: the public RPC caps eth_getLogs at a 100-block window, so logs cannot be the map.
const MULTICALL = '0xcA11bde05977b3631167028862bE2a173976CA11';
const N = 24; // 6 x 4 coarse zones; a cell is a zone, never a precise position
const cellKey = (i) => '0x' + i.toString(16).padStart(64, '0');
const TICKER = 100n; // the widest log range the RPC answers

// The projector and every phone poll this, so one scan is shared for a few seconds.
let cache = { at: 0, body: null };

export async function GET() {
  const to = address();
  if (!to) return NextResponse.json({ ok: false, error: 'no contract' }, { status: 500 });
  if (Date.now() - cache.at < 3000 && cache.body) return NextResponse.json(cache.body);

  const head = await pub.getBlockNumber();
  const from = head > TICKER ? head - TICKER : 0n;
  const [agg, logs, newest, oldest] = await Promise.all([
    pub.multicall({
      multicallAddress: MULTICALL,
      allowFailure: true,
      contracts: [
        ...Array.from({ length: N }, (_, i) => ({ address: to, abi, functionName: 'cells', args: [cellKey(i)] })),
        { address: to, abi, functionName: 'totalAccepted' },
        { address: to, abi, functionName: 'totalRejected' },
        { address: to, abi, functionName: 'deviceCount' },
      ],
    }),
    pub.getLogs({ address: to, fromBlock: from, toBlock: head }).catch(() => []),
    pub.getBlock({ blockNumber: head }),
    pub.getBlock({ blockNumber: from }),
  ]);

  const REASON = ['accepted', 'unknown device', 'revoked device', 'stale counter (replay)', 'bad signature'];
  const COLOR_WORD = ['unusable', 'poor', 'ok', 'excellent'];
  const cells = {};
  agg.slice(0, N).forEach((r, i) => {
    if (r.status !== 'success' || Number(r.result[0]) === 0) return;
    const [n, gradeSum, opinionSum, worst] = r.result;
    cells[i] = {
      n: Number(n),
      grade: Number(gradeSum),   // divide by n at draw time: keep the sum on the wire
      opinion: Number(opinionSum),
      worst: Number(worst),
    };
  });

  const recent = [];
  for (const l of logs) {
    let ev;
    try { ev = decodeEventLog({ abi, data: l.data, topics: l.topics }); } catch { continue; }
    if (ev.eventName === 'Committed') {
      recent.push({
        kind: 'Committed', device: ev.args.deviceId, grade: Number(ev.args.grade),
        opinion: Number(ev.args.opinion), trust: String(ev.args.trust),
        said: COLOR_WORD[ev.args.opinion],
      });
    } else if (ev.eventName === 'Rejected') {
      recent.push({ kind: 'Rejected', device: ev.args.deviceId, reason: REASON[Number(ev.args.reason)] ?? 'rejected' });
    } else if (ev.eventName === 'Enrolled') {
      recent.push({ kind: 'Enrolled', device: ev.args.deviceId });
    }
  }

  const ok = (r) => r.status === 'success' ? r.result : 0n;
  const body = {
    ok: true,
    head: String(head),
    totalAccepted: String(ok(agg[N])),
    totalRejected: String(ok(agg[N + 1])),
    devices: String(ok(agg[N + 2])),
    secondsPerBlock: (Number(newest.timestamp - oldest.timestamp) / Number(head - from || 1n)).toFixed(2),
    tickerWindow: Number(head - from),
    cells,
    recent: recent.slice(-30),
  };
  cache = { at: Date.now(), body };
  return NextResponse.json(body);
}
