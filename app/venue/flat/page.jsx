'use client';
import { useEffect, useState } from 'react';
import { COLS, N, WORD, cellColor } from '../../../lib/zones.js';
import Cheat from '../cheat.jsx';

export default function Venue() {
  const [st, setSt] = useState(null);
  const [origin, setOrigin] = useState('');

  useEffect(() => {
    setOrigin(location.origin);
    const load = () => fetch('/api/state').then((r) => r.json()).then(setSt).catch(() => {});
    load();
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, []);

  const cells = st?.cells ?? {};
  const recent = (st?.recent ?? []).slice(-9).reverse();

  return (
    <main style={{ padding: '28px 40px', minHeight: '100vh', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 40 }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 46, margin: 0 }}>Ground Truth</h1>
          <p style={{ fontSize: 21, color: '#9fb0c0', margin: '8px 0 22px', maxWidth: 620 }}>
            Every reading below was signed inside a phone&apos;s secure element and verified
            onchain by the P-256 precompile. The room is the sensor network.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${COLS}, 1fr)`, gap: 10, maxWidth: 640 }}>
            {Array.from({ length: N }, (_, i) => {
              const c = cells[i];
              return (
                <div key={i} style={{
                  aspectRatio: '1', borderRadius: 12, background: cellColor(c),
                  border: '1px solid #23282f', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 26, fontWeight: 800, color: c ? '#04070a' : '#3a4552',
                }}>{c ? c.n : ''}</div>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 26, marginTop: 20, fontSize: 19, color: '#cfd8e0', flexWrap: 'wrap' }}>
            <span><b>{st?.devices ?? 0}</b> devices</span>
            <span><b>{st?.totalAccepted ?? 0}</b> attestations onchain</span>
            <span style={{ color: '#e08e0b' }}><b>{st?.totalRejected ?? 0}</b> refused</span>
            <span><b>{st?.secondsPerBlock ?? '–'}</b>s per block</span>
          </div>
          <div style={{ marginTop: 12, fontSize: 16, color: '#7f8fa0' }}>
            each reading carries a P-256 verify at 6,900 gas; 108,584 gas per reading in a batch of five vs about 169,500 alone
          </div>
        </div>

        <div style={{ width: 330, textAlign: 'center' }}>
          {origin && (
            <img src={`/api/qr?target=${encodeURIComponent(origin)}`} width={320} height={320}
              style={{ background: '#fff', borderRadius: 14, padding: 8 }} alt="Scan to contribute a reading" />
          )}
          <div style={{ fontSize: 20, marginTop: 10 }}>Scan. One tap enrolls your passkey, one tap attests.</div>
          <div style={{ fontSize: 15, color: '#8fa0b0', marginTop: 6 }}>{origin?.replace(/^https:\/\//, '')}</div>
        </div>
      </div>

      <div style={{ marginTop: 24, maxWidth: 560 }}>
        <Cheat fontSize={18} />
      </div>

      <div style={{ marginTop: 26, borderTop: '1px solid #1d242c', paddingTop: 12, fontSize: 17 }}>
        {recent.map((r, i) => (
          <div key={i} style={{ color: r.kind === 'Rejected' ? '#e08e0b' : '#8fa0b0' }}>
            {r.kind === 'Rejected'
              ? `✗ ${r.reason} — device ${r.device?.slice(0, 10)}… refused`
              : r.kind === 'Enrolled'
                ? `+ device ${r.device?.slice(0, 10)}… enrolled its passkey`
                : `✓ ${WORD[r.opinion]} claimed / ${WORD[r.grade]} measured — trust ${r.trust}`}
          </div>
        ))}
      </div>
    </main>
  );
}
