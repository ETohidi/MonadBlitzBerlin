// Browser side: passkey enrolment + signing, and the measurement a device attests to.
const b64u = {
  enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''),
  dec: (s) => {
    const b = atob(s.replaceAll('-', '+').replaceAll('_', '/'));
    return Uint8Array.from(b, (c) => c.charCodeAt(0));
  },
};

const KEY = 'groundtruth.credential';

/// Finds a COSE x/y pair inside the CBOR a passkey hands back. We only ever register
/// P-256 keys we created ourselves, so label 0x21 / 0x22 followed by bytes(32) is stable.
export function coseXY(cbor) {
  const u = new Uint8Array(cbor);
  const find = (label) => {
    for (let i = 0; i < u.length - 34; i++) {
      if (u[i] === label && u[i + 1] === 0x58 && u[i + 2] === 0x20) return u.slice(i + 3, i + 35);
      if (u[i] === label && u[i + 1] >= 0x40 && u[i + 1] <= 0x5f && u[i + 1] - 0x40 === 32) return u.slice(i + 2, i + 34);
    }
    return null;
  };
  const x = find(0x21); const y = find(0x22);
  if (!x || !y) throw new Error('no P-256 key found in attestation');
  return { x: b64u.enc(x), y: b64u.enc(y), xHex: '0x' + [...x].map((v) => v.toString(16).padStart(2, '0')).join('') , yHex: '0x' + [...y].map((v) => v.toString(16).padStart(2, '0')).join('') };
}

export async function enrol() {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: 'Ground Truth', id: location.hostname },
      user: { id: challenge, name: 'attendee@groundtruth', displayName: 'attendee' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      timeout: 60_000,
      attestation: 'none',
    },
  });
  const resp = cred.response;
  let cbor;
  if (typeof resp.getPublicKey === 'function') cbor = resp.getPublicKey();
  else cbor = resp.getAttestationObject();
  const { xHex, yHex } = coseXY(cbor);
  const id = b64u.enc(cred.rawId);
  sessionStorage.setItem(KEY, id);
  return { credentialId: id, x: xHex, y: yHex };
}

export function hasCredential() { return sessionStorage.getItem(KEY); }

export async function sign(challengeBytes) {
  const id = hasCredential();
  const assert = await navigator.credentials.get({
    publicKey: {
      challenge: challengeBytes,
      rpId: location.hostname,
      allowCredentials: id ? [{ type: 'public-key', id: b64u.dec(id) }] : [],
      userVerification: 'required',
      timeout: 60_000,
    },
  });
  const hex = (buf) => '0x' + [...new Uint8Array(buf)].map((v) => v.toString(16).padStart(2, '0')).join('');
  return {
    authenticatorData: hex(assert.response.authenticatorData),
    clientDataJSON: hex(assert.response.clientDataJSON),
    derSignature: hex(assert.response.signature),
  };
}

/// Latency + jitter + a small downlink sample, measured from the page itself.
/// Browsers cannot read RSSI, so this measures what a browser actually can: the network.
export async function measure(resourceUrl) {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    try {
      await fetch(`${resourceUrl}${resourceUrl.includes('?') ? '&' : '?'}n=${Math.random()}`, { cache: 'no-store' });
      samples.push(performance.now() - t);
    } catch { samples.push(2000); }
  }
  samples.sort((a, b) => a - b);
  const lat = Math.round(samples[2]);
  const jitter = Math.round(samples[4] - samples[0]);
  const bytes = 200_000;
  const t = performance.now();
  let down = 0;
  try {
    const r = await fetch(`${resourceUrl}${resourceUrl.includes('?') ? '&' : '?'}big=1`, { cache: 'no-store' });
    await r.arrayBuffer();
    down = Math.round((bytes * 8) / ((performance.now() - t) / 1000) / 1000);
  } catch { down = 0; }

  // grade: 0 unusable .. 3 excellent, from the measurement alone
  const grade = lat < 60 && jitter < 25 && down > 5000 ? 3 : lat < 150 && down > 1500 ? 2 : lat < 400 && down > 400 ? 1 : 0;
  return { lat, jitter, down, grade };
}
