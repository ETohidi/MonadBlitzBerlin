'use client';
import { useEffect, useState } from 'react';
import { enrol, sign, measure, hasCredential } from '../lib/passkey.js';

const COLS = 6; const N = 24;
const cellHex = (i) => '0x' + i.toString(16).padStart(64, '0');
const OPINIONS = [['unusable', 0], ['poor', 1], ['ok', 2], ['excellent', 3]];
const COLOR = ['#c0392b', '#e08e0b', '#c9b920', '#2ecc71'];

export default function Home() {
  const [device, setDevice] = useState(null);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [cell, setCell] = useState(null);
  const [result, setResult] = useState(null);
  const [st, setSt] = useState(null);

  useEffect(() => {
    const load = () => fetch('/api/state').then((r) => r.json()).then(setSt).catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);

  async function doEnrol() {
    setBusy('enrol'); setNote('Unlock your passkey — this proves possession of a key your phone cannot export.');
    try {
      const { x, y } = await enrol();
      const proof = await sign(crypto.getRandomValues(new Uint8Array(32)));
      const r = await fetch('/api/enrol', { method: 'POST', body: JSON.stringify({ x, y, proof }) }).then((r) => r.json());
      if (!r.ok) throw new Error(r.error ?? 'rejected');
      setDevice(r.deviceId);
      setNote(r.exists ? 'Device already on this record. Trust: ' + r.trust : `Enrolled onchain. ${r.gasUsed} gas · tx ${r.tx?.slice(0, 14)}…`);
    } catch (e) { setNote('Enrol failed: ' + e.message); }
    setBusy('');
  }

  async function attest(opinion) {
    if (!device) return setNote('Enrol first.');
    if (cell === null) return setNote('Tap where you are standing.');
    setBusy('attest'); setNote('Measuring from this page…');
    try {
      const m = await measure('/api/ping');
      const ts = Date.now();
      const payload = { deviceId: device, opinion, ...m, cell: cellHex(cell), ts };
      const ch = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload))));
      const sig = await sign(ch);
      setNote(`lat ${m.lat}ms · jitter ${m.jitter}ms · down ${m.down}kbps → signed, submitting…`);
      const r = await fetch('/api/attest', {
        method: 'POST',
        body: JSON.stringify({ deviceId: device, opinion, grade: m.grade, cell: cellHex(cell), lat: m.lat, jitter: m.jitter, down: m.down, ts, sig }),
      }).then((r) => r.json());
      setResult(r);
      setNote(r.ok ? `Committed. Your tap and your measurement scored ${r.trust}.` : `Rejected: ${r.reason ?? r.error}`);
    } catch (e) { setNote('Failed: ' + e.message); }
    setBusy('');
  }

  const cells = st?.cells ?? {};

  return (
    <main style={{ maxWidth: 560, margin: '0 auto', padding: '20px 16px 60px' }}>
      <h1 style={{ fontSize: 30, margin: '4px 0 2px' }}>Ground Truth</h1>
      <p style={{ margin: '0 0 18px', color: '#9fb0c0', fontSize: 15 }}>
        Your phone measures the network where you are standing and <b>signs it in hardware</b>.
        The signature is verified onchain by the P-256 precompile. Nobody can edit the record,
        and nobody can backdate it.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${COLS}, 1fr)`, gap: 6, margin: '0 0 14px' }}>
        {Array.from({ length: N }, (_, i) => {
          const c = cells[i];
          const avg = c ? Math.round(c.grade / c.n) : null;
          return (
            <button key={i} onClick={() => setCell(i)}
              style={{
                aspectRatio: '1', border: cell === i ? '2px solid #fff' : '1px solid #23282f',
                borderRadius: 8, background: c ? COLOR[avg] : '#14181d', color: '#04070a',
                fontSize: 12, fontWeight: 700, padding: 0,
              }}>
              {c ? c.n : ''}
            </button>
          );
        })}
      </div>

      <button onClick={doEnrol} disabled={!!busy || !!device}
        style={{ width: '100%', padding: '14px', marginBottom: 10, border: 'none', borderRadius: 10, fontWeight: 700, fontSize: 17, background: device ? '#1d2530' : '#2ecc71', color: device ? '#7f8fa0' : '#04120a' }}>
        {device ? '✓ Device enrolled' : hasCredential() ? 'Re-enrol passkey' : '1 · Enrol this phone'}
      </button>

      <div style={{ fontSize: 14, color: '#9fb0c0', marginBottom: 6 }}>
        2 · Tap your cell above &nbsp; 3 · Then: how does the network feel here?
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
        {OPINIONS.map(([label, v]) => (
          <button key={v} onClick={() => attest(v)} disabled={!!busy}
            style={{ padding: '13px 4px', border: '1px solid #2a323d', borderRadius: 10, background: '#161b22', color: '#e8edf2', fontWeight: 700, fontSize: 13 }}>
            {label}
          </button>
        ))}
      </div>

      <p aria-live="polite" style={{ minHeight: 44, fontSize: 14, color: '#cfd8e0' }}>{note}</p>

      {result?.ok && (
        <div style={{ background: '#10161c', border: '1px solid #24303c', borderRadius: 10, padding: 12, fontSize: 13 }}>
          <div><b>Verified onchain</b> — your device&apos;s signature checked by precompile <code>0x0100</code></div>
          <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
            <span>gas <b>{result.gasUsed}</b></span>
            <span>cost <b>{Number(result.costMono).toExponential(1)} MON</b></span>
            <span>counter <b>{result.counter}</b></span>
            <span>trust <b>{result.trust}</b></span>
          </div>
          <a href={`https://testnet.monadscan.com/tx/${result.tx}`} target="_blank" rel="noreferrer" style={{ color: '#5aa9e6' }}>
            view transaction {result.tx?.slice(0, 18)}…
          </a>
        </div>
      )}

      {st && (
        <div style={{ marginTop: 18, borderTop: '1px solid #1d242c', paddingTop: 12, fontSize: 13, color: '#8fa0b0', display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          <span>{st.devices} devices</span>
          <span>{st.totalAccepted} attestations onchain</span>
          <span style={{ color: st.totalRejected > 0 ? '#e08e0b' : undefined }}>{st.totalRejected} rejected</span>
          <span>{st.secondsPerBlock}s per block</span>
          <span>head {st.head}</span>
        </div>
      )}
    </main>
  );
}
