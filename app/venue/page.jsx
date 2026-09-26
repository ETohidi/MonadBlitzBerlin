'use client';
import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { zoneRect, CENTRE, COLS, N } from '../../lib/zones.js';

const COLOR = ['#c0392b', '#e08e0b', '#c9b920', '#2ecc71'];
const WORD = ['unusable', 'poor', 'ok', 'excellent'];
const STYLE = 'https://demotiles.maplibre.org/style.json';

/// 24 rectangles over the CIC site, in the same order the attendee grid uses.
function zoneData(cells) {
  return {
    type: 'FeatureCollection',
    features: Array.from({ length: N }, (_, i) => {
      const r = zoneRect(i);
      const c = cells[i];
      return {
        type: 'Feature',
        properties: { i, filled: c ? 1 : 0, color: c ? COLOR[Math.round(c.grade / c.n)] : '#1a1f26' },
        geometry: { type: 'Polygon', coordinates: [[[r.west, r.south], [r.east, r.south], [r.east, r.north], [r.west, r.north], [r.west, r.south]]] },
      };
    }),
  };
}

export default function Venue() {
  const holder = useRef(null);
  const mapRef = useRef(null);
  const stRef = useRef(null);
  const [st, setSt] = useState(null);
  const [live, setLive] = useState(false);
  const [why, setWhy] = useState('');
  const [attack, setAttack] = useState(null);
  const [attacking, setAttacking] = useState(false);
  const [origin, setOrigin] = useState('');

  useEffect(() => {
    setOrigin(location.origin);
    const load = () => fetch('/api/state').then((r) => r.json())
      .then((s) => { setSt(s); stRef.current = s; if (mapRef.current) mapRef.current.getSource('zones')?.setData(zoneData(s.cells ?? {})); })
      .catch(() => {});
    load();
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, []);

  // rotating earth -> Berlin -> the CIC floor plan. If the tiles cannot be reached, the
  // grid below still carries every number, and /venue/flat is the whole page without them.
  useEffect(() => {
    if (!holder.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: holder.current, style: STYLE, center: [-30, 20], zoom: 0.9,
      minZoom: 0.5, maxZoom: 18, attributionControl: false, interactive: false,
    });
    mapRef.current = map;
    let raf = 0;
    const timers = [];
    const at = (ms, fn) => timers.push(setTimeout(fn, ms));

    map.on('load', () => {
      try {
        try { map.setProjection({ type: 'globe' }); } catch { /* older projection API */ }
        map.addSource('zones', { type: 'geojson', data: zoneData(stRef.current?.cells ?? {}) });
        map.addLayer({
          id: 'zone-fill', type: 'fill', source: 'zones',
          paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['interpolate', ['linear'], ['get', 'filled'], 0, 0.35, 1, 0.9] },
        });
        map.addLayer({
          id: 'zone-line', type: 'line', source: 'zones',
          paint: { 'line-color': '#8fa0b0', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 16, 2.2], 'line-opacity': 0.55 },
        });
      } catch (e) { setLive(false); setWhy('layers: ' + e.message); return; }
      setLive(true);

      // Spin, then two hops: the planet, Berlin, the floor. Timed rather than chained on
      // moveend, because a dropped frame must not strand the sequence mid-flight.
      const t0 = performance.now();
      let lng = -30;
      const spin = () => {
        const dt = performance.now() - t0;
        if (dt > 4200) return;
        lng += 0.16;
        map.jumpTo({ center: [lng, 16 + Math.sin(dt / 900) * 4], zoom: 1.02 + dt / 26000 });
        raf = requestAnimationFrame(spin);
      };
      spin();
      at(4400, () => map.flyTo({ center: [CENTRE.lng, CENTRE.lat], zoom: 11.2, duration: 3400, curve: 1.3 }));
      at(8000, () => map.easeTo({ center: [CENTRE.lng, CENTRE.lat], zoom: 15.9, pitch: 52, duration: 3000 }));
      at(11200, () => map.setOptions({ interactive: true, dragRotate: true, scrollZoom: true }));
      at(20000, () => map.easeTo({ center: [CENTRE.lng, CENTRE.lat], zoom: 15.4, pitch: 38, duration: 2600 }));
    });
    map.on('error', (e) => setWhy((w) => w || `style: ${e?.error?.message ?? e?.statusText ?? 'unknown'}`));
    return () => { cancelAnimationFrame(raf); timers.forEach(clearTimeout); map.remove(); mapRef.current = null; };
  }, []);

  const cells = st?.cells ?? {};
  const recent = (st?.recent ?? []).slice(-7).reverse();
  const filled = Object.keys(cells).length;

  return (
    <main style={{ display: 'flex', gap: 22, padding: '20px 26px', minHeight: '100vh', boxSizing: 'border-box' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h1 style={{ fontSize: 34, margin: 0 }}>Ground Truth <span style={{ fontSize: 19, color: '#9fb0c0', fontWeight: 400 }}>CIC Berlin · 52.4940, 13.4463</span></h1>
          <span style={{ fontSize: 15, color: live ? '#2ecc71' : '#e08e0b' }}>{live ? 'globe live' : why ? `globe unavailable — ${why}` : 'globe unavailable — numbers below still live'}</span>
        </div>
        <div ref={holder} style={{ height: 'calc(100vh - 330px)', minHeight: 340, borderRadius: 14, overflow: 'hidden', background: '#04070a', border: '1px solid #23282f', margin: '10px 0 12px' }} />
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${COLS}, 1fr)`, gap: 6, maxWidth: 560 }}>
          {Array.from({ length: N }, (_, i) => {
            const c = cells[i];
            const avg = c ? Math.round(c.grade / c.n) : null;
            return (
              <div key={i} style={{
                aspectRatio: '1.6', borderRadius: 7, background: c ? COLOR[avg] : '#14181d',
                border: '1px solid #23282f', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 15, fontWeight: 800, color: c ? '#04070a' : '#3a4552',
              }}>{c ? c.n : ''}</div>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 22, marginTop: 14, fontSize: 17, color: '#cfd8e0', flexWrap: 'wrap' }}>
          <span><b>{st?.devices ?? 0}</b> devices</span>
          <span><b>{st?.totalAccepted ?? 0}</b> attestations onchain</span>
          <span style={{ color: '#e08e0b' }}><b>{st?.totalRejected ?? 0}</b> refused</span>
          <span><b>{filled}</b>/24 zones reporting</span>
          <span><b>{st?.secondsPerBlock ?? '–'}</b>s per block</span>
          <span style={{ color: '#8fa0b0' }}>6,900 gas per P-256 verify</span>
        </div>
      </div>

      <div style={{ width: 320, flexShrink: 0, textAlign: 'center' }}>
        {origin && (
          <img src={`/api/qr?target=${encodeURIComponent(origin)}`} width={300} height={300}
            style={{ background: '#fff', borderRadius: 14, padding: 8 }} alt="Scan to contribute a reading" />
        )}
        <div style={{ fontSize: 19, marginTop: 8 }}>Scan. One tap enrolls your passkey, one tap attests.</div>
        <div style={{ fontSize: 14, color: '#8fa0b0', marginTop: 4 }}>{origin?.replace(/^https:\/\//, '')}</div>
        <div style={{ fontSize: 14, color: '#8fa0b0', marginTop: 14, textAlign: 'left' }}>
          Each zone is ~200 m across. The squares above are the same 24 zones drawn on the globe;
          the numbers come from contract storage, not from a database behind this page.
        </div>
        <button onClick={async () => {
          setAttacking(true); setAttack(null);
          const r = await fetch('/api/attack', { method: 'POST' }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
          setAttack(r); setAttacking(false);
        }} disabled={attacking}
          style={{ marginTop: 14, width: '100%', padding: '12px 16px', borderRadius: 10, border: '1px solid #4a3118', background: '#2a1c0e', color: '#f0c674', fontWeight: 700, fontSize: 16 }}>
          {attacking ? 'Submitting to the chain…' : '▶ Run the attacker: replay, ghost key, forged signature'}
        </button>
        {attack?.ok && (
          <div style={{ marginTop: 10, fontSize: 16, color: '#f0c674', textAlign: 'left' }}>
            chain refused {attack.refused.length}/3 — {attack.refused.join(' · ')} — {attack.gasUsed} gas
          </div>
        )}
        {attack && !attack.ok && <div style={{ marginTop: 10, color: '#e08e0b' }}>{attack.error}</div>}
        <div style={{ marginTop: 16, borderTop: '1px solid #1d242c', paddingTop: 10, fontSize: 15, textAlign: 'left' }}>
          {recent.map((r, i) => (
            <div key={i} style={{ color: r.kind === 'Rejected' ? '#e08e0b' : r.kind === 'Enrolled' ? '#5aa9e6' : '#8fa0b0' }}>
              {r.kind === 'Rejected'
                ? `✗ ${r.reason} — device ${r.device?.slice(0, 10)}… refused`
                : r.kind === 'Enrolled'
                  ? `＋ passkey enrolled ${r.device?.slice(0, 10)}…`
                  : `✓ ${WORD[r.opinion]} claimed / ${WORD[r.grade]} measured — trust ${r.trust}`}
            </div>
          ))}
        </div>
        <a href="/venue/flat" style={{ fontSize: 13, color: '#5a6b7a' }}>flat fallback view</a>
      </div>
    </main>
  );
}
