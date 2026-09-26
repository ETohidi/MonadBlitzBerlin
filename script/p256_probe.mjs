// Proves the whole WebAuthn -> P-256 -> Monad precompile path works,
// without needing a phone, a wallet, or a compiler.
import crypto from 'node:crypto';

const RPC = process.argv[2] ?? 'https://testnet-rpc.monad.xyz';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
});

// Raw point: DER-encoded SPKI ends with 04 || x || y
const spki = publicKey.export({ type: 'spki', format: 'der' });
const raw = spki.subarray(spki.length - 65);
if (raw[0] !== 0x04) throw new Error('expected uncompressed point');
const x = raw.subarray(1, 33);
const y = raw.subarray(33, 65);

const rpIdHash = crypto.createHash('sha256').update('groundtruth.local').digest();
const flags = Buffer.from([0x45]); // UP, UV, AT
const counter = Buffer.alloc(4);
counter.writeUInt32BE(1);
const authenticatorData = Buffer.concat([rpIdHash, flags, counter]);

const payload = {
  lat: 41, jit: 12, down: 96_000, opinion: 2, cell: '0x' + 'ab'.repeat(32), ts: Date.now(),
};
const challenge = crypto.createHash('sha256')
  .update(Buffer.from(JSON.stringify(payload))).digest('hex');

const clientDataJSON = Buffer.from(JSON.stringify({
  type: 'webauthn.get', challenge: Buffer.from(challenge, 'hex').toString('base64url'),
  origin: 'https://groundtruth.local',
}));

const sigData = Buffer.concat([authenticatorData, crypto.createHash('sha256').update(clientDataJSON).digest()]);
const hash = crypto.createHash('sha256').update(sigData).digest();
const der = crypto.sign('sha256', sigData, { key: privateKey, dsaEncoding: 'der' });

// DER: 30 len 02 rlen r 02 slen s
function derToRS(d) {
  if (d[0] !== 0x30 || d[1] !== d.length - 2) throw new Error('bad der header');
  let p = 2;
  const pad32 = (v) => {
    if (v[0] === 0x00) v = v.subarray(1);
    return Buffer.concat([Buffer.alloc(32 - v.length), v]);
  };
  const readInt = () => {
    if (d[p] !== 0x02) throw new Error('bad int tag');
    const len = d[p + 1];
    const v = d.subarray(p + 2, p + 2 + len);
    p += 2 + len;
    return pad32(v);
  };
  const r = readInt(); const s = readInt();
  return { r, s };
}
const { r, s } = derToRS(der);

const okLocal = crypto.verify('sha256', sigData, { key: publicKey, dsaEncoding: 'der' }, der);
console.log('local node verify:', okLocal);
console.log('sig len der:', der.length, 'r/s hex:', r.toString('hex'), s.toString('hex'));

const input = Buffer.concat([hash, r, s, x, y]);
if (input.length !== 160) throw new Error('input must be 160 bytes, got ' + input.length);

const call = async (method, params) => {
  const res = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
};

const chainId = await call('eth_chainId', []);
const out = await call('eth_call', [{ to: '0x0000000000000000000000000000000000000100', data: '0x' + input.toString('hex') }, 'latest']);
console.log('chain:', parseInt(chainId, 16), '(', RPC, ')');
console.log('precompile 0x0100 output:', out);

// also prove a tampered hash is rejected
const bad = Buffer.from(input); bad[0] ^= 0x01;
const outBad = await call('eth_call', [{ to: '0x0000000000000000000000000000000000000100', data: '0x' + bad.toString('hex') }, 'latest']);
console.log('tampered output:', outBad === '0x' ? 'empty (rejected)' : outBad);

const gas = await call('eth_estimateGas', [{ to: '0x0000000000000000000000000000000000000100', data: '0x' + input.toString('hex') }]).catch(() => 'n/a');
console.log('gas for one precompile call:', gas);
