// One attendee without a phone: drives the same endpoints the QR page calls, so the
// room-generated map can be rehearsed — and replayed for a judge if the WiFi dies.
//   node script/mock_phone.mjs [base-url] [devices]
// A real device signs with its secure element; this signs with Node's P-256, which is
// the same curve, same encoding, same precompile check.
import { newDevice, attest } from '../lib/attest.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3000';
const COUNT = Number(process.argv[3] ?? 3);
const N = 24;
const cellHex = (i) => '0x' + i.toString(16).padStart(64, '0');
const WORD = ['unusable', 'poor', 'ok', 'excellent'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// JSON has no bigint; the counters are far inside Number.MAX_SAFE_INTEGER here.
const numeric = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]));

async function post(path, body) {
  const r = await fetch(BASE + path, body ? { method: 'POST', body: JSON.stringify(body) } : { method: 'POST' });
  return { status: r.status, json: await r.json().catch(() => null) };
}

/// A phone's radio readings: latency samples and a downlink probe, graded 0..3.
/// The browser measures the same thing; the grade function lives in lib/attest.mjs's caller.
function radio() {
  const lat = Math.round(20 + Math.random() * 260);
  const jitter = Math.round(Math.random() * 40);
  const down = Math.round(2000 + Math.random() * 400000);
  const grade = lat > 200 || down < 20000 ? 0 : lat > 120 || down < 80000 ? 1 : lat > 60 ? 2 : 3;
  return { lat, jitter, down, grade };
}

async function get(path) {
  const r = await fetch(BASE + path);
  return r.json().catch(() => null);
}

console.log(`${BASE} — ${COUNT} scripted attendees`);
for (let i = 0; i < COUNT; i++) {
  const d = newDevice();
  const proof = attest(d, { counter: 1, opinion: 2, grade: 2 });
  const e = await post('/api/enrol', { x: d.xHex, y: d.yHex, proof: numeric(proof) });
  if (!e.json?.ok) { console.log(`  enrol failed: ${JSON.stringify(e.json)}`); continue; }
  const pending = e.json.pending ? await settleFor(e.json.tx) : null;
  console.log(`  device ${d.id.slice(0, 10)}… ${e.json.exists ? 'was already enrolled' : 'enrolled'}${e.json.pending ? ` (block ${pending?.block ?? '…'})` : ''}`);

  const m = radio();
  const cell = Math.floor(Math.random() * N);
  const ts = Date.now();
  const opinion = Math.max(0, Math.min(3, m.grade + (Math.random() < 0.25 ? 1 : 0))); // sometimes optimistic
  const sig = attest(d, { counter: Number(proof.counter) + 1, opinion, grade: m.grade, cell: cellHex(cell), lat: m.lat, jitter: m.jitter, down: m.down, ts });
  const a = await post('/api/attest', {
    deviceId: d.id, opinion, grade: m.grade, cell: cellHex(cell),
    lat: m.lat, jitter: m.jitter, down: m.down, ts,
    sig: { authenticatorData: sig.authenticatorData, clientDataJSON: sig.clientDataJSON, derSignature: sig.derSignature },
  });
  let out = a.json ?? {};
  if (out.pending) out = { ...out, ...(await settleFor(out.tx) ?? {}) };
  console.log(`    cell ${String(cell).padStart(2)} · said ${WORD[opinion].padEnd(9)} · measured ${WORD[m.grade].padEnd(9)} · ${m.lat}ms ${m.down}kbps -> ${out.accepted ? `trust ${out.trust}` : `refused: ${out.reason ?? out.error}`} ${out.gasUsed ? `${out.gasUsed} gas` : ''} ${out.tx ? out.tx.slice(0, 12) + '…' : ''}`);
}

async function settleFor(tx, budget = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < budget) {
    const j = await get(`/api/receipt?tx=${tx}`);
    if (j?.found) return j;
    await sleep(1500);
  }
  return null;
}

const st = await get('/api/state');
console.log(`\nchain now: ${st.totalAccepted} attestations, ${st.totalRejected} rejected, ${st.devices} devices, head ${st.head} (${st.secondsPerBlock}s/block)`);
console.log('cells (n / avg measured grade):');
for (const [i, c] of Object.entries(st.cells).sort((a, b) => a[0] - b[0])) {
  console.log(`  ${String(i).padStart(2, '0')}  ${'▓'.repeat(c.n)}${'·'.repeat(Math.max(0, 8 - c.n))} n=${c.n} avg=${(c.grade / c.n).toFixed(1)}`);
}
