'use client';
import { useState } from 'react';

// In the order /api/attack submits them.
const CHEATS = [
  ['Replay a real report', 'StaleCounter', 'already seen'],
  ['Report from an unregistered phone', 'UnknownDevice', 'unknown key'],
  ['Fake a signature for a real phone', 'BadSignature', 'signature invalid'],
];
const PLAIN = { StaleCounter: 'already seen', UnknownDevice: 'unknown key', BadSignature: 'signature invalid', Revoked: 'revoked key' };

export default function Cheat({ fontSize = 17 }) {
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true); setRes(null);
    const r = await fetch('/api/attack', { method: 'POST' }).then((x) => x.json()).catch((e) => ({ ok: false, error: String(e) }));
    setRes(r); setBusy(false);
  }

  return (
    <div>
      <button onClick={run} disabled={busy}
        style={{ width: '100%', padding: '12px 16px', borderRadius: 10, border: '1px solid #5a2020', background: '#2a1010', color: '#ffb4a8', fontWeight: 700, fontSize: fontSize + 2 }}>
        {busy ? 'Submitting to the chain…' : 'Try to cheat'}
      </button>
      {res?.ok && (
        <div style={{ marginTop: 10, fontSize, lineHeight: 1.5, textAlign: 'left' }}>
          {CHEATS.map(([what, code, word], i) => {
            const got = res.outcomes?.[i];
            const text = got === code ? `refused: ${word}` : got === 'Accepted' ? 'ACCEPTED' : got ? `refused: ${PLAIN[got] ?? got}` : 'no result';
            return <div key={code} style={{ color: got && got !== 'Accepted' ? '#ffb4a8' : '#ffd24a' }}>{what} → {text}</div>;
          })}
          <div style={{ color: '#8fa0b0', fontSize: fontSize - 3 }}>{res.gasUsed} gas for the three, one transaction</div>
        </div>
      )}
      {res && !res.ok && <div style={{ marginTop: 10, color: '#f2a516', fontSize }}>{res.error}</div>}
    </div>
  );
}
