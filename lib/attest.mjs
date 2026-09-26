// Fabricates WebAuthn-shaped P-256 attestations: the same byte layout a phone's
// secure element produces, so the contract path is tested against real shapes.
import crypto from 'node:crypto';
import { keccak256, concat } from 'viem';

const ORIGIN = 'https://groundtruth.local';

export function newDevice() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const raw = spki.subarray(spki.length - 65);
  const x = raw.subarray(1, 33);
  const y = raw.subarray(33, 65);
  // must match the contract: deviceId = keccak256(abi.encodePacked(x, y))
  const id = keccak256(concat([hex(x), hex(y)]));
  return { privateKey, x, y, xHex: hex(x), yHex: hex(y), id };
}

function derToRS(d) {
  const pad = (v) => (v[0] === 0x00 ? Buffer.concat([Buffer.alloc(33 - v.length), v]).subarray(1) : Buffer.concat([Buffer.alloc(32 - v.length), v]));
  if (d[0] !== 0x30 || d[1] !== d.length - 2) throw new Error('bad der');
  let p = 2;
  const read = () => { const l = d[p + 1]; const v = d.subarray(p + 2, p + 2 + l); p += 2 + l; return pad(v); };
  return { r: read(), s: read() };
}

const hex = (b) => '0x' + Buffer.from(b).toString('hex');

/// Builds one attestation. `sign` decides what the device commits to; `tamper`
/// exists so the attack demos go through the real contract path rather than a mock.
export function attest(device, { counter, opinion, grade, cell = '0x' + '00'.repeat(32), lat = 40, jitter = 8, down = 90000, ts = Date.now(), tamper = null } = {}) {
  const payloadHash = hex(crypto.createHash('sha256')
    .update(JSON.stringify({ counter, opinion, grade, cell, lat, jitter, down, ts })).digest());

  const rpIdHash = crypto.createHash('sha256').update(ORIGIN).digest();
  const flags = Buffer.from([0x45]); // UP + UV + AT, as a phone passkey reports
  const ctr = Buffer.alloc(4); ctr.writeUInt32BE(counter);
  const authenticatorData = Buffer.concat([rpIdHash, flags, ctr]);

  const clientDataJSON = Buffer.from(JSON.stringify({
    type: 'webauthn.get',
    challenge: Buffer.from(payloadHash.slice(2), 'hex').toString('base64url'),
    origin: ORIGIN,
  }));

  const sigData = Buffer.concat([authenticatorData, crypto.createHash('sha256').update(clientDataJSON).digest()]);
  const der = crypto.sign('sha256', sigData, { key: device.privateKey, dsaEncoding: 'der' });
  const { r, s } = derToRS(der);

  const a = {
    deviceId: device.id,
    counter: BigInt(counter),
    opinion,
    grade,
    cell,
    payloadHash,
    authenticatorData: hex(authenticatorData),
    clientDataJSON: hex(clientDataJSON),
    derSignature: hex(der),
  };
  if (tamper === 'signature') {
    const flipped = Buffer.from(r); flipped[31] ^= 0x01;
    a.derSignature = hex(derToSigFromRS(flipped, s));
  }
  return a;
}

function derToSigFromRS(r, s) {
  const enc = (b) => {
    let v = Buffer.from(b);
    while (v.length > 1 && v[0] === 0x00 && v[1] < 0x80) v = v.subarray(1);
    const pad = v[0] >= 0x80;
    const body = pad ? Buffer.concat([Buffer.from([0x00]), v]) : v;
    return Buffer.concat([Buffer.from([0x02, body.length]), body]);
  };
  const inner = Buffer.concat([enc(r), enc(s)]);
  return Buffer.concat([Buffer.from([0x30, inner.length]), inner]);
}

export const coordHex = (b) => hex(b);
