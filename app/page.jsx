'use client';
import { useEffect, useState } from 'react';
import { enrol, sign, measure, hasCredential } from '../lib/passkey.js';
import { zoneOf, HOME_ZONE, COLS, N, cellHex } from '../lib/zones.js';

const OPINIONS = [['unusable', 0], ['poor', 1], ['ok', 2], ['excellent', 3]];
const COLOR = ['#c0392b', '#e08e0b', '#c9b920', '#2ecc71'];
const MAX_ACCURACY = 200;

export default function Home() {
  const [device, setDevice] = useState(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [cell, setCell] = useState(null);
  const [result, setResult] = useState(null);
  const [st, setSt] = useState(null);
  const [where, setWhere] = useState('locating…');

  useEffect(() => {
    setSaved(!!hasCredential());
    const load = () => fetch('/api/state').then((r) => r.json()).then(setSt).catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);

  // One fix, asked once. A zone is 6×4 over the whole site, so ±200 m is already generous —
  // past that the honest answer is "we are assuming the middle of the building", and we say so.
  useEffect(() => {
    const assume = (why) => { setCell(HOME_ZONE); setWhere(`location: CIC (assumed) — ${why}`); };
    if (!navigator.geolocation) return assume('this browser has no geolocation');
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const { latitude, longitude, accuracy } = p.coords;
        if (accuracy > MAX_ACCURACY) return assume(`fix uncertain by ±${Math.round(accuracy)} m`);
        const { zone, distance } = zoneOf(latitude, longitude);
        if (distance > 260) return assume(`you are ~${distance} m outside the grid`);
        setCell(zone);
        setWhere(`zone ${zone + 1} of ${N} · fix ±${Math.round(accuracy)} m · ${distance} m from its centre`);
      },
      (e) => assume(e.code === 1 ? 'you declined' : 'no fix in time'),
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 60_000 },
    );
  }, []);

  async function doEnrol() {
    setBusy('enrol'); setNote('Unlock your passkey — this proves possession of a key your phone cannot export.');
    try {
      const { x, y, via } = await enrol();
      const proof = await sign(crypto.getRandomValues(new Uint8Array(32)));
      const r = await fetch('/api/enrol', { method: 'POST', body: JSON.stringify({ x, y, proof }) }).then((r) => r.json());
      if (!r.ok) throw new Error(r.error ?? 'rejected');
      setDevice(r.deviceId);
      if (r.exists) {
        setNote(`Device already on this record. Trust: ${r.trust} · key read from the ${via}`);
      } else {
        setNote('Signature checked; waiting for the enrolment to land in a block…');
        const rc = r.pending ? await settle(r) : { status: 'success', gasUsed: r.gasUsed };
        setNote(rc?.status === 'success'
          ? `Enrolled onchain via ${via}. ${rc.gasUsed} gas · tx ${r.tx.slice(0, 14)}…`
          : `Broadcast, not in a block yet — the map will pick it up. tx ${r.tx.slice(0, 14)}…`);
      }
    } catch (e) { setNote('Enrol failed: ' + e.message); report('enrol', e.message); }
    setBusy('');
  }

  // the note is on someone else's phone; the log is on my machine
  function report(stage, message) {
    fetch('/api/diag', { method: 'POST', body: JSON.stringify({ stage, message, ua: navigator.userAgent }) }).catch(() => {});
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
      if (r.ok && r.pending) {
        setNote('Signed in hardware, broadcast. Waiting for a block…');
        const rc = await settle(r);
        if (rc?.found) {
          setResult({ ...r, ...rc });
          setNote(rc.accepted
            ? `Committed in block ${rc.block}. Your tap and your measurement scored ${rc.trust}.`
            : `The contract refused it: ${rc.reason}.`);
        } else {
          setNote('Still in flight — the map picks it up on the next poll.');
        }
      }
    } catch (e) { setNote('Failed: ' + e.message); report('attest', e.message); }
    setBusy('');
  }

  const cells = st?.cells ?? {};

  async function settle(r, deadline = 45000) {
    const t0 = Date.now();
    while (Date.now() - t0 < deadline) {
      const rc = await fetch(`/api/receipt?tx=${r.tx}`).then((x) => x.json()).catch(() => null);
      if (rc?.found) return { ...r, ...rc, pending: false };
      await new Promise((res) => setTimeout(res, 1600));
    }
    return r;
  }

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
        {device ? '✓ Device enrolled' : saved ? 'Re-enrol passkey' : '1 · Enrol this phone'}
      </button>

      <div style={{ fontSize: 14, color: cell === HOME_ZONE ? '#e08e0b' : '#9fb0c0', margin: '0 0 10px' }}>
        {where}{cell !== null && cell !== HOME_ZONE ? ' · tap another square to override' : ''}
      </div>

      <div style={{ fontSize: 14, color: '#9fb0c0', marginBottom: 6 }}>
        2 · {cell === null ? 'Tap your cell above' : `Zone ${cell + 1} selected — tap another to change`} &nbsp; 3 · Then: how does the network feel here?
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
