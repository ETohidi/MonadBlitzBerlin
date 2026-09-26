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
const hexOf = (u) => [...u].map((v) => v.toString(16).padStart(2, '0')).join('');

// CBOR, just enough of it to find a credential public key in whatever shape a passkey
// hands back. Written out because the WebAuthn response is the one place where vendors
// disagree on how the key is wrapped, and a byte scan hides that instead of reporting it.
function head(u, p) {
  const ib = u[p];
  const a = ib & 0x1f;
  let val = a, next = p + 1;
  if (a === 24) { val = u[next]; next += 1; }
  else if (a === 25) { val = (u[next] << 8) | u[next + 1]; next += 2; }
  else if (a === 26) { val = ((u[next] << 24) | (u[next + 1] << 16) | (u[next + 2] << 8) | u[next + 3]) >>> 0; next += 4; }
  else if (a === 27) { val = 0; for (let i = 0; i < 8; i++) val = val * 256 + u[next + i]; next += 8; }
  else if (a > 27 && a < 31) throw new Error('reserved CBOR additional info');
  return { mt: ib >> 5, val, indef: a === 31, next };
}

const BREAK = 0xff;

function decode(u, p) {
  const h = head(u, p);
  if (h.mt === 0) return { v: h.val, next: h.next };
  if (h.mt === 1) return { v: -1 - h.val, next: h.next };
  if (h.mt === 2 || h.mt === 3) {
    const chunks = [];
    let at = h.next;
    if (h.indef) {
      while (u[at] !== BREAK) { const c = decode(u, at); chunks.push(c.v); at = c.next; }
      at += 1;
    } else { chunks.push(u.slice(at, at + h.val)); at += h.val; }
    const joined = chunks.reduce((n, c) => { const o = new Uint8Array(n.length + c.length); o.set(n); o.set(c, n.length); return o; }, new Uint8Array(0));
    return { v: h.mt === 2 ? joined : new TextDecoder().decode(joined), next: at };
  }
  if (h.mt === 4) {
    const arr = []; let at = h.next;
    const n = h.indef ? -1 : h.val;
    while (n < 0 ? u[at] !== BREAK : arr.length < n) { const c = decode(u, at); arr.push(c.v); at = c.next; }
    if (n < 0) at += 1;
    return { v: arr, next: at };
  }
  if (h.mt === 5) {
    const m = new Map(); let at = h.next;
    const n = h.indef ? -1 : h.val;
    while (n < 0 ? u[at] !== BREAK : m.size < n) {
      const k = decode(u, at); const v = decode(u, k.next);
      m.set(k.v, v.v); at = v.next;
    }
    if (n < 0) at += 1;
    return { v: m, next: at };
  }
  if (h.mt === 6) return decode(u, h.next);            // tag: unwrap
  return { v: h.val === 20 ? false : h.val === 21 ? true : h.val === 22 ? null : undefined, next: h.next };
}

const get = (m, k) => (m instanceof Map ? (m.has(k) ? m.get(k) : m.get(String(k))) : undefined);

function xyOf(k) {
  if (!(k instanceof Map)) return null;
  const x = get(k, -2); const y = get(k, -3);
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array)) return null;
  if (x.length !== 32 || y.length !== 32) return null;
  return { x, y };
}

/// authenticatorData = rpIdHash(32) ‖ flags(1) ‖ counter(4) ‖ [AT] aaguid(16) ‖ credIdLen(2) ‖ credId ‖ COSE_Key
function xyOfAuthData(ad) {
  if (!(ad instanceof Uint8Array) || ad.length < 55) return { xy: null, why: `authData too short (${ad?.length ?? 0} B)` };
  const flags = ad[32];
  if (!(flags & 0x40)) return { xy: null, why: `AT flag clear (flags=0x${flags.toString(16)}): the authenticator embedded no key` };
  const credIdLen = (ad[53] << 8) | ad[54];
  if (ad.length < 55 + credIdLen) return { xy: null, why: `credIdLen ${credIdLen} overruns authData` };
  try {
    const xy = xyOf(decode(ad, 55 + credIdLen).v);
    return { xy, why: xy ? null : 'no -2/-3 byte strings after the credential id' };
  } catch (e) { return { xy: null, why: `CBOR after credId: ${e.message}` }; }
}

/// Accepts a bare COSE_Key, a full attestationObject, or raw authenticatorData.
function unpack(input) {
  if (typeof input === 'string') return { xy: null, why: `response was text, not bytes: "${input.slice(0, 24)}"` };
  const u = input instanceof Uint8Array ? input : input == null ? null : new Uint8Array(input);
  if (!u || u.length === 0) return { xy: null, why: `response was ${input === null ? 'null' : input === undefined ? 'undefined' : 'an empty buffer'}` };
  let obj;
  try { obj = decode(u, 0).v; } catch { obj = null; }
  if (obj instanceof Map) {
    const direct = xyOf(obj);
    if (direct) return { xy: direct, u };                       // bare COSE_Key
    const ad = get(obj, 'authData');
    if (ad) { const r = xyOfAuthData(ad); if (r.xy) return { xy: r.xy, u }; return { xy: null, why: r.why, u }; }
    const fmt = get(obj, 'fmt');
    return { xy: null, why: `CBOR map without authData (fmt=${fmt ?? '?'}, ${obj.size} keys)`, u };
  }
  if (u.length >= 55) { const r = xyOfAuthData(u); if (r.xy) return { xy: r.xy, u }; return { xy: null, why: r.why, u }; }
  return { xy: null, why: 'not a CBOR map and not long enough to be authenticatorData', u };
}

const dump = (u) => `${u.length} B: ${hexOf(u.subarray(0, 40))}${u.length > 40 ? '…' : ''}`;

/// Accepts every shape the browser offered. Throws with what it actually saw: a failure
/// here happens on a stranger's phone, so the message is the only instrument available.
export function coseXY(...inputs) {
  const notes = [];
  for (const input of inputs) {
    const r = unpack(input);
    if (r.xy) {
      const { x, y } = r.xy;
      return { x: b64u.enc(x), y: b64u.enc(y), xHex: '0x' + hexOf(x), yHex: '0x' + hexOf(y) };
    }
    notes.push(r.why + (r.u ? ` [${dump(r.u)}]` : ''));
  }
  throw new Error(`no P-256 key found in attestation — ${notes.join(' | ')}`);
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
  // attestationObject before getPublicKey(): the former is the older, universally
  // implemented accessor, so a getPublicKey() quirk cannot by itself lose the enrolment.
  const offered = [
    ['attestationObject', () => resp.getAttestationObject?.()],
    ['getPublicKey', () => resp.getPublicKey?.()],
  ].map(([name, fn]) => {
    try { return { name, v: fn() }; } catch (e) { return { name, v: null, threw: e.message }; }
  });
  // `via` is reported on success too: which accessor a given phone actually used is the
  // one fact about the audience's devices that a single test cannot be guessed from.
  let out = null;
  const notes = [];
  for (const o of offered) {
    try { out = { ...coseXY(o.v), via: o.name }; break; }
    catch (e) { notes.push(`${o.name}: ${o.threw ? `threw ${o.threw}` : e.message}`); }
  }
  if (!out) throw new Error(`${notes.join(' | ')} :: rawId ${cred.rawId.byteLength} B`);
  const { xHex, yHex, via } = out;
  const id = b64u.enc(cred.rawId);
  sessionStorage.setItem(KEY, id);
  return { credentialId: id, x: xHex, y: yHex, via };
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
  const hex = (buf) => '0x' + hexOf(new Uint8Array(buf));
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
  const t = performance.now();
  let down = 0;
  try {
    await fetch(`${resourceUrl}${resourceUrl.includes('?') ? '&' : '?'}big=1`, { cache: 'no-store' })
      .then((r) => r.arrayBuffer())
      // kbps from the bytes that actually arrived, not from the size the endpoint intended
      .then((b) => { down = Math.round((b.byteLength * 8) / ((performance.now() - t) / 1000) / 1000); });
  } catch { down = 0; }

  // grade: 0 unusable .. 3 excellent, from the measurement alone
  const grade = lat < 60 && jitter < 25 && down > 5000 ? 3 : lat < 150 && down > 1500 ? 2 : lat < 400 && down > 400 ? 1 : 0;
  return { lat, jitter, down, grade };
}
