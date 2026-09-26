// The browser's COSE parser is the one part of the phone path that cannot be exercised
// from Node's WebAuthn-shaped factory, so its output is checked here directly: a real
// CBOR-encoded P-256 key must come back as the same coordinates that verify a signature.
import { coseXY } from '../lib/passkey.js';
import { verifySig } from '../lib/chain.mjs';
import { newDevice, attest } from '../lib/attest.mjs';

const bytes = (hex) => Uint8Array.from(Buffer.from(hex.replace('0x', ''), 'hex'));
const cborBytes = (u) => [0x58, 0x20, ...u];

/// AuthenticatorData.getPublicKey() shape: a bare COSE_Key map.
/// Labels -2/-3 encode as 0x21/0x22, which is what coseXY scans for.
function coseKey(xHex, yHex) {
  return Uint8Array.from([
    0xa5,
    0x04, 0x02,                    // kty: EC2
    0x26, 0x01,                    // alg: -7 (ES256)
    0x27, 0x01,                    // crv: 1 (P-256)
    0x21, ...cborBytes(bytes(xHex)),
    0x22, ...cborBytes(bytes(yHex)),
  ]);
}

function attestationObject(xHex, yHex) {
  const inner = coseKey(xHex, yHex);
  const aaguid = new Uint8Array(16);
  const authData = Uint8Array.from([
    ...bytes('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'), // rpIdHash
    0x45, 0x00, 0x00, 0x00, 0x01,                                                 // flags + counter
    ...aaguid, 0x00, 0x20, ...inner,                                              // credIdLen + credId
  ]);
  const str = (s) => [0x60 + s.length, ...Buffer.from(s, 'utf8')];
  const bstr = (u) => [0x58, u.length, ...u];
  return Uint8Array.from([
    0xa3,
    ...str('fmt'), ...str('none'),
    ...str('attStmt'), 0xa0,
    ...str('authData'), ...bstr(authData),
  ]);
}

let failed = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
};

for (const [i, d] of [newDevice(), newDevice(), newDevice()].entries()) {
  const bare = coseXY(coseKey(d.xHex, d.yHex));
  check(`device ${i}: bare COSE x`, bare.xHex, d.xHex);
  check(`device ${i}: bare COSE y`, bare.yHex, d.yHex);
  const wrapped = coseXY(attestationObject(d.xHex, d.yHex));
  check(`device ${i}: attestationObject x`, wrapped.xHex, d.xHex);
  check(`device ${i}: attestationObject y`, wrapped.yHex, d.yHex);

  // the coordinates the browser would send must be the ones the signature checks out against
  const sig = attest(d, { counter: 1, opinion: 2, grade: 2 });
  check(`device ${i}: that key verifies the attestation`, verifySig(wrapped.xHex, wrapped.yHex, sig), true);
  const other = newDevice();
  check(`device ${i}: another key does not`, verifySig(other.xHex, other.yHex, sig), false);
}

try {
  coseXY(Uint8Array.from([0xa0, 0x00, 0x01]));
  console.log('  FAIL  junk CBOR should throw'); failed++;
} catch { console.log('  PASS  junk CBOR throws "no P-256 key found in attestation"'); }

console.log(failed ? `\n${failed} check(s) failed` : '\ncoseXY is sound: same bytes in, same coordinates out, wrong key refused');
process.exit(failed ? 1 : 0);
