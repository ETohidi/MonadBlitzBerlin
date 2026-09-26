// The browser's COSE parser is the one part of the phone path that cannot be exercised
// from Node's WebAuthn-shaped factory, so its output is checked here directly: a real
// CBOR-encoded P-256 key must come back as the same coordinates that verify a signature,
// out of every wrapper a vendor is known to use — and a failure must say what it saw.
import { coseXY } from '../lib/passkey.js';
import { verifySig } from '../lib/chain.mjs';
import { newDevice, attest } from '../lib/attest.mjs';

const bytes = (hex) => Uint8Array.from(Buffer.from(hex.replace('0x', ''), 'hex'));

/// CBOR encoders, written out by hand rather than pulled in: this test exists to pin the
/// decoder against bytes computed from the spec, not against another library's opinion.
const u16 = (v) => [(v >> 8) & 0xff, v & 0xff];
const txt = (s) => [0x60 + s.length, ...Buffer.from(s, 'utf8')];
const bstr = (u) => (u.length < 24 ? [0x40 + u.length, ...u]
  : u.length < 256 ? [0x58, u.length, ...u] : [0x59, ...u16(u.length), ...u]);

/// A bare COSE_Key for P-256: kty=2, alg=-7 (ES256), crv=1 (P-256), x=label -2, y=label -3.
function coseKeyBytes(xHex, yHex) {
  const x = bytes(xHex); const y = bytes(yHex);
  return Uint8Array.from([0xa5, 0x04, 0x02, 0x26, 0x01, 0x27, 0x01, 0x21, ...bstr(x), 0x22, ...bstr(y)]);
}

/// Non-canonical but legal: indefinite-length map, terminated by a break byte.
function coseKeyIndef(xHex, yHex) {
  const k = coseKeyBytes(xHex, yHex);
  return Uint8Array.from([0xbf, ...k.subarray(1), 0xff]);
}

/// AuthenticatorData = rpIdHash ‖ flags ‖ counter ‖ [AT] aaguid ‖ credIdLen ‖ credId ‖ COSE_Key
function authData(xHex, yHex, { flags = 0x45, credIdLen = 32, withKey = true } = {}) {
  const rpIdHash = bytes('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  const credId = new Uint8Array(credIdLen).fill(0xab);
  return Uint8Array.from([
    ...rpIdHash, flags, 0x00, 0x00, 0x00, 0x01,
    ...new Uint8Array(16), ...u16(credIdLen), ...credId,
    ...(withKey ? coseKeyBytes(xHex, yHex) : new Uint8Array(0)),
  ]);
}

function attestationObject(ad, fmt = 'none') {
  return Uint8Array.from([
    0xa3,
    ...txt('fmt'), ...txt(fmt),
    ...txt('attStmt'), 0xa0,
    ...txt('authData'), ...bstr(ad),
  ]);
}

let failed = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${String(got).slice(0, 90)}, want ${String(want).slice(0, 90)})`}`);
};

const d = newDevice();
const sig = attest(d, { counter: 1, opinion: 2, grade: 2 });
const accepts = (name, input) => {
  const k = coseXY(input);
  check(name, k.xHex === d.xHex && k.yHex === d.yHex, true);
  return k;
};

// --- every wrapper a passkey is known to use ------------------------------------
accepts('bare COSE_Key (what getPublicKey returns)', coseKeyBytes(d.xHex, d.yHex));
accepts('bare COSE_Key, indefinite-length map', coseKeyIndef(d.xHex, d.yHex));
const wrapped = accepts('attestationObject → authData (Safari with no getPublicKey)',
  attestationObject(authData(d.xHex, d.yHex)));
accepts('raw authenticatorData', authData(d.xHex, d.yHex));
accepts('attestationObject, fmt=apple', attestationObject(authData(d.xHex, d.yHex), 'apple'));
accepts('200-byte credential id', attestationObject(authData(d.xHex, d.yHex, { credIdLen: 200 })));
accepts('a key inside a real-length attestationObject', attestationObject(authData(d.xHex, d.yHex, { credIdLen: 16 })));

// --- the coordinates must be the ones the signature checks out against ----------
check('extracted key verifies the attestation', verifySig(wrapped.xHex, wrapped.yHex, sig), true);
const wrong = newDevice();
check('a different key does not', verifySig(wrong.xHex, wrong.yHex, sig), false);
// an x from one device and a y from another is not a curve point at all, and a browser can
// send exactly that: it must read as "does not verify", not as a 500 from a thrown OpenSSL error
check('a mismatched x/y pair is refused, not thrown', verifySig(wrong.xHex, d.yHex, sig), false);
check('garbage coordinates are refused, not thrown', verifySig('0xzz', undefined, sig), false);
check('base64url agrees with hex', wrapped.x, Buffer.from(wrapped.xHex.slice(2), 'hex').toString('base64url'));

// --- the iPhone failure mode: one accessor is broken, the other is fine --------
check('undefined offer falls through to the next shape', coseXY(undefined, coseKeyBytes(d.xHex, d.yHex)).yHex, d.yHex);
check('null offer falls through too', coseXY(null, coseKeyBytes(d.xHex, d.yHex)).xHex, d.xHex);
check('garbage offer falls through too', coseXY(new Uint8Array(0), attestationObject(authData(d.xHex, d.yHex))).xHex, d.xHex);

// --- failures must explain themselves ------------------------------------------
const expectThrow = (name, input, needle) => {
  try { coseXY(input); console.log(`  FAIL  ${name}: no throw`); failed++; }
  catch (e) {
    const hit = e.message.includes(needle);
    check(`${name} → "${needle}"`, hit, true);
    if (!hit) console.log(`        message was: ${e.message}`);
  }
};
expectThrow('accessor absent (undefined)', undefined, 'undefined');
expectThrow('accessor returned null', null, 'null');
expectThrow('accessor returned text', 'aGVsbG8', 'text');
expectThrow('accessor returned zero bytes', new Uint8Array(0), 'empty buffer');
expectThrow('AT flag clear, no key embedded', authData(d.xHex, d.yHex, { flags: 0x05, withKey: false }), 'AT flag clear');
expectThrow('junk CBOR', Uint8Array.from([0xa0, 0x00, 0x01]), 'no P-256 key');
expectThrow('attestationObject without authData',
  Uint8Array.from([0xa2, ...txt('fmt'), ...txt('none'), ...txt('attStmt'), 0xa0]), 'without authData');
expectThrow('authData whose key is truncated',
  authData(d.xHex, d.yHex).subarray(0, 60), 'no P-256 key');

// the message has to carry the bytes, because the phone is not within reaching distance
try { coseXY(Uint8Array.from([0xa2, ...txt('fmt'), ...txt('none'), ...txt('attStmt'), 0xa0])); }
catch (e) { check('diagnostics include a hex dump', /[0-9]+ B: [0-9a-f]{16}/.test(e.message), true); }

console.log(failed ? `\n${failed} check(s) failed` : '\ncoseXY: same key out of every wrapper, wrong key refused, every failure described');
process.exit(failed ? 1 : 0);
