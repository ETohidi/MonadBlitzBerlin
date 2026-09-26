'use client';
import { useEffect, useState } from 'react';

const COLS = 6; const N = 24;
const COLOR = ['#c0392b', '#e08e0b', '#c9b920', '#2ecc71'];
const WORD = ['unusable', 'poor', 'ok', 'excellent'];

export default function Venue() {
  const [st, setSt] = useState(null);
  const [attack, setAttack] = useState(null);
  const [attacking, setAttacking] = useState(false);
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
              const avg = c ? Math.round(c.grade / c.n) : null;
              return (
                <div key={i} style={{
                  aspectRatio: '1', borderRadius: 12, background: c ? COLOR[avg] : '#14181d',
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
            each reading carries a P-256 verify at 6,900 gas; ≈104k gas in a batch of five
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

      <div style={{ marginTop: 24 }}>
        <button onClick={async () => {
          setAttacking(true); setAttack(null);
          const r = await fetch('/api/attack', { method: 'POST' }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
          setAttack(r); setAttacking(false);
        }} disabled={attacking}
          style={{ padding: '12px 20px', borderRadius: 10, border: '1px solid #4a3118', background: '#2a1c0e', color: '#f0c674', fontWeight: 700, fontSize: 17 }}>
          {attacking ? 'Submitting to the chain…' : '▶ Run the attacker: replay, ghost key, forged signature'}
        </button>
        {attack?.ok && (
          <span style={{ marginLeft: 18, fontSize: 18, color: '#f0c674' }}>
            chain refused {attack.refused.length}/3 — {attack.refused.join(' · ')} — {attack.gasUsed} gas
          </span>
        )}
        {attack && !attack.ok && <span style={{ marginLeft: 18, color: '#e08e0b' }}>{attack.error}</span>}
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
