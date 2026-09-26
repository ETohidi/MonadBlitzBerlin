'use client';
import { useEffect, useRef, useState } from 'react';
import { enrol, sign, measure, storedDevice } from '../lib/passkey.js';
import { zoneOf, HOME_ZONE, cellHex, LEVELS, N, cellColor, zoneRing, zoneCentre, footprintAt, END_LABELS, FOOTPRINT, CONTRACT_SHORT } from '../lib/zones.js';
import { readingJSON } from '../lib/reading.js';

const MAX_ACCURACY = 200;
const MAX_OFF_GRID_M = 100;
const FRESH_MS = 30_000;

// The zones in local metres, north up, exactly as the projector draws them.
const M_LNG = 111320 * Math.cos((FOOTPRINT.nwNE.lat * Math.PI) / 180);
const local = ([lng, lat]) => [(lng - FOOTPRINT.nwNE.lng) * M_LNG, (FOOTPRINT.nwNE.lat - lat) * 111320];
const SHAPES = Array.from({ length: N }, (_, i) => zoneRing(i).slice(0, 4).map(local));
const CENTRES = Array.from({ length: N }, (_, i) => { const c = zoneCentre(i); return local([c.lng, c.lat]); });
const ENDS = { nw: local(footprintAt(-0.1, 0.5)), se: local(footprintAt(1.09, 0.5)) };
const VIEW = (() => {
  const pts = [...SHAPES.flat(), ENDS.nw, ENDS.se];
  const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]); const pad = 6;
  return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) - Math.min(...xs) + 2 * pad, Math.max(...ys) - Math.min(...ys) + 2 * pad];
})();

function report(message) {
  fetch('/api/diag', { method: 'POST', body: JSON.stringify({ stage: 'tap', message, ua: navigator.userAgent }) }).catch(() => {});
}

async function settle(tx, deadline = 45_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadline) {
    const rc = await fetch(`/api/receipt?tx=${tx}`).then((x) => x.json()).catch(() => null);
    if (rc?.found) return rc;
    await new Promise((res) => setTimeout(res, 1500));
  }
  return null;
}

async function deviceState(deviceId) {
  const r = await fetch(`/api/device?id=${deviceId}`).then((x) => x.json()).catch(() => null);
  return r?.ok ? { next: BigInt(r.next), revoked: !!r.revoked } : null;
}

export default function Home() {
  const [zone, setZone] = useState(HOME_ZONE);
  const picked = useRef(false);
  const [cells, setCells] = useState({});
  // Measured in the background so a tap goes straight to the passkey prompt: iOS Safari
  // refuses a WebAuthn call that comes too long after the gesture that asked for it.
  const latest = useRef({ m: null, at: 0, counter: null, revoked: false, running: false });
  const tapping = useRef(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  async function refresh() {
    const l = latest.current;
    if (l.running || tapping.current) return;
    l.running = true;
    try {
      const m = await measure('/api/ping');
      // a failed probe clears the old value rather than letting it pass for a current one
      Object.assign(l, m ? { m, at: Date.now() } : { m: null, at: 0 });
      const d = storedDevice();
      const ds = d ? await deviceState(d.deviceId) : null;
      l.counter = ds?.next ?? null;
      l.revoked = !!ds?.revoked;
    } finally { l.running = false; }
  }

  useEffect(() => {
    navigator.geolocation?.getCurrentPosition(
      (p) => {
        if (picked.current || p.coords.accuracy > MAX_ACCURACY) return;
        const { zone: z, distance } = zoneOf(p.coords.latitude, p.coords.longitude);
        if (distance <= MAX_OFF_GRID_M) setZone(z);
      },
      () => {},
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 60_000 },
    );
    refresh();
    const t = setInterval(() => { if (Date.now() - latest.current.at > FRESH_MS) refresh(); }, 3000);
    const loadCells = () => fetch('/api/state').then((r) => r.json()).then((s) => s.ok && setCells(s.cells ?? {})).catch(() => {});
    loadCells();
    const c = setInterval(loadCells, 4000);
    return () => { clearInterval(t); clearInterval(c); };
  }, []);

  async function submit(device, stored, opinion) {
    const l = latest.current;
    // a key the chain has never seen starts at 1; a stored one uses the counter fetched before the tap
    const counter = stored ? (l.counter ?? (await deviceState(device.deviceId))?.next) : 1n;
    if (counter == null) throw new Error('relay unreachable, tap again');
    const m = l.m;
    const ts = Date.now();
    const cell = cellHex(zone);
    const reading = readingJSON({ deviceId: device.deviceId, counter, opinion, grade: m.grade, cell, lat: m.lat, jitter: m.jitter, down: m.down, ts });
    const ch = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(reading)));
    const sig = await sign(ch, device.id);
    setStatus('sent');
    const r = await fetch('/api/attest', {
      method: 'POST',
      body: JSON.stringify({ deviceId: device.deviceId, x: device.x, y: device.y, opinion, grade: m.grade, cell, lat: m.lat, jitter: m.jitter, down: m.down, ts, sig }),
    }).then((x) => x.json());
    if (r.revoked) return { revoked: true };
    if (r.error || (!r.ok && r.accepted == null && !r.pending)) throw new Error(r.reason ?? r.error ?? 'refused');
    if (r.deduped) return { deduped: true };
    const rc = r.block ? r : await settle(r.tx);
    return rc?.reason === 'revoked device' ? { revoked: true } : rc;
  }

  async function tap(opinion) {
    const l = latest.current;
    if (!l.m || Date.now() - l.at > 2 * FRESH_MS) {
      setStatus(l.running ? 'measuring, tap again in a moment' : "couldn't measure, tap again");
      if (!l.running) refresh();
      return;
    }
    tapping.current = true;
    setBusy(true); setStatus('');
    try {
      // Anyone can revoke any device on this contract. A revoked phone gets a fresh passkey,
      // which the relay enrols and attests in one transaction; the person only sees "sent".
      const stored = l.revoked ? null : storedDevice();
      let rc = await submit(stored ?? await enrol(), !!stored, opinion);
      if (rc?.revoked) rc = await submit(await enrol(), false, opinion);
      if (!rc) setStatus('sent · not in a block yet');
      else if (rc.revoked) throw new Error('refused, tap again');
      else if (rc.deduped) setStatus('onchain ✓');
      else if (rc.accepted === false) setStatus(`refused onchain · block ${rc.block}`);
      else setStatus(`onchain ✓ block ${rc.block}`);
    } catch (e) {
      setStatus(e.message);
      report(e.message);
    } finally {
      tapping.current = false;
      setBusy(false);
      latest.current.at = 0; // re-measure after every tap
      refresh();
    }
  }

  return (
    <main style={{ minHeight: '100dvh', boxSizing: 'border-box', padding: 16, display: 'flex', flexDirection: 'column', gap: 12, justifyContent: 'center' }}>
      <svg viewBox={VIEW.join(' ')} style={{ width: '100%', maxHeight: '44dvh' }} role="group" aria-label="zones of the building">
        {SHAPES.map((pts, i) => {
          const c = cells[i];
          return (
            <polygon key={i} points={pts.map((p) => p.join(',')).join(' ')} role="button" aria-label={`zone ${i + 1}`} aria-pressed={i === zone}
              onClick={() => { if (!busy) { picked.current = true; setZone(i); } }}
              fill={cellColor(c)} stroke="#0b0d10" strokeWidth={0.8} strokeLinejoin="round" style={{ cursor: 'pointer' }}>
              <title>{`${c?.n ?? 0} report${c?.n === 1 ? '' : 's'}`}</title>
            </polygon>
          );
        })}
        <polygon points={SHAPES[zone].map((p) => p.join(',')).join(' ')} fill="none" stroke="#fff" strokeWidth={1.8} strokeLinejoin="round" pointerEvents="none" />
        <text x={CENTRES[zone][0]} y={CENTRES[zone][1]} fill="#fff" stroke="#000" strokeWidth={0.6} paintOrder="stroke" fontSize={4.5} fontWeight={700} textAnchor="middle" dominantBaseline="central" pointerEvents="none">
          {cells[zone]?.n ?? 0}
        </text>
        {Object.entries(ENDS).map(([k, [x, y]]) => (
          <text key={k} x={x} y={y} fill="#9fb0c0" fontSize={5} textAnchor="middle" dominantBaseline="middle">{END_LABELS[k]}</text>
        ))}
      </svg>
      {[...LEVELS].reverse().map(({ label, value, color }) => (
        <button key={value} onClick={() => tap(value)} disabled={busy}
          style={{ flex: '0 0 13dvh', border: 0, borderRadius: 18, background: color, color: '#0b0d10', fontSize: 32, fontWeight: 700, opacity: busy ? 0.5 : 1 }}>
          {label}
        </button>
      ))}
      <p aria-live="polite" style={{ minHeight: 24, margin: 0, textAlign: 'center', fontSize: 18, color: '#c9d4de' }}>{status}</p>
      <p style={{ margin: 0, textAlign: 'center', fontSize: 11, color: '#6b7a88' }}>Powered by Monad testnet · contract {CONTRACT_SHORT}</p>
    </main>
  );
}
