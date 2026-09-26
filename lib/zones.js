// The venue grid: 24 zones, 6 columns by 4 rows, laid over the CIC Berlin building.
// A zone id is the only location that ever reaches the chain, so this file is the whole
// mapping between a coordinate and a claim — and the projector draws the same cells.
export const CENTRE = { lat: 52.4940, lng: 13.4463 };
export const COLS = 6;
export const ROWS = 4;
export const N = COLS * ROWS;

// The building footprint, read off Esri World Imagery at zoom 19: the wide north-west end
// and the narrow south-east end, each by its north-east and south-west corner.
export const FOOTPRINT = {
  nwNE: { lat: 52.494220, lng: 13.446413 },
  nwSW: { lat: 52.493962, lng: 13.446037 },
  seNE: { lat: 52.493334, lng: 13.447708 },
  seSW: { lat: 52.493248, lng: 13.447660 },
};
export const END_LABELS = { nw: 'NW end', se: 'SE end' };

const M_LAT = 111320;
const M_LNG = M_LAT * Math.cos((FOOTPRINT.nwNE.lat * Math.PI) / 180);

/// Bilinear position in the footprint: s runs NW end -> SE end (columns), t runs
/// north-east side -> south-west side (rows). Returns [lng, lat].
export function footprintAt(s, t) {
  const { nwNE: a, nwSW: b, seNE: c, seSW: d } = FOOTPRINT;
  const mix = (k) => (1 - s) * (1 - t) * a[k] + s * (1 - t) * c[k] + (1 - s) * t * b[k] + s * t * d[k];
  return [mix('lng'), mix('lat')];
}

/// Inverse of footprintAt, by Newton's method in local metres.
function unmap(lat, lng) {
  const m = ([x, y]) => [(x - FOOTPRINT.nwNE.lng) * M_LNG, (y - FOOTPRINT.nwNE.lat) * M_LAT];
  const [A, B, C, D] = ['nwNE', 'nwSW', 'seNE', 'seSW'].map((k) => m([FOOTPRINT[k].lng, FOOTPRINT[k].lat]));
  const X = m([lng, lat]);
  let s = 0.5; let t = 0.5;
  for (let k = 0; k < 30; k++) {
    const [px, py] = m(footprintAt(s, t));
    const fx = px - X[0]; const fy = py - X[1];
    const ds = [(1 - t) * (C[0] - A[0]) + t * (D[0] - B[0]), (1 - t) * (C[1] - A[1]) + t * (D[1] - B[1])];
    const dt = [(1 - s) * (B[0] - A[0]) + s * (D[0] - C[0]), (1 - s) * (B[1] - A[1]) + s * (D[1] - C[1])];
    const det = ds[0] * dt[1] - ds[1] * dt[0];
    const stepS = (fx * dt[1] - fy * dt[0]) / det;
    const stepT = (ds[0] * fy - ds[1] * fx) / det;
    s -= stepS; t -= stepT;
    if (Math.abs(stepS) + Math.abs(stepT) < 1e-12) break;
  }
  return { s, t };
}

const edge = (c, r) => footprintAt(c / COLS, r / ROWS);

/// Zone i as a closed ring of [lng, lat]; row-major, zone 0 at the NW end on the north-east side.
export function zoneRing(i) {
  const c = i % COLS; const r = Math.floor(i / COLS);
  return [edge(c, r), edge(c + 1, r), edge(c + 1, r + 1), edge(c, r + 1), edge(c, r)];
}

export const gridRing = () => [edge(0, 0), edge(COLS, 0), edge(COLS, ROWS), edge(0, ROWS), edge(0, 0)];

export function zoneCentre(i) {
  const [lng, lat] = footprintAt(((i % COLS) + 0.5) / COLS, (Math.floor(i / COLS) + 0.5) / ROWS);
  return { lat, lng };
}

const mPer = (lat) => ({ lat: 111320, lng: 111320 * Math.cos((lat * Math.PI) / 180) });

export function distanceM(a, b) {
  const k = mPer((a.lat + b.lat) / 2);
  return Math.hypot((a.lat - b.lat) * k.lat, (a.lng - b.lng) * k.lng);
}

/// The zone containing the point, or the nearest one along the edge, and how far outside
/// the footprint the point sat (0 inside).
export function zoneOf(lat, lng) {
  const { s, t } = unmap(lat, lng);
  const cl = (v) => Math.min(Math.max(v, 0), 1 - 1e-9);
  const zone = Math.floor(cl(t) * ROWS) * COLS + Math.floor(cl(s) * COLS);
  const [elng, elat] = footprintAt(Math.min(Math.max(s, 0), 1), Math.min(Math.max(t, 0), 1));
  return { zone, distance: Math.round(distanceM({ lat, lng }, { lat: elat, lng: elng })) };
}

export const CONTRACT_SHORT = '0x01da…F55F';

// One palette for the attendee buttons and the venue cells.
export const LEVELS = [
  { label: 'poor', value: 1, color: '#d63b3b' },
  { label: 'ok', value: 2, color: '#f2a516' },
  { label: 'excellent', value: 3, color: '#27ae60' },
];
export const NO_DATA = '#5b6470';
export const WORD = ['unusable', 'poor', 'ok', 'excellent'];

/// A cell's unweighted mean on the display scale poor 0 · ok 1 · excellent 2. On chain the
/// buttons are 1..3 and older readings may hold 0 (unusable), which folds into poor.
export const scoreOf = (sum, n) => Math.min(Math.max(sum / n - 1, 0), 2);

// sRGB <-> OKLab, so the red -> amber -> green ramp stays vivid between the stops.
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLin = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
function oklch(hex) {
  const [r, g, b] = [1, 3, 5].map((k) => toLin(parseInt(hex.slice(k, k + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}
function hexOf([L, C, h]) {
  const A = C * Math.cos(h); const B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
  return '#' + rgb.map((v) => Math.round(Math.min(Math.max(fromLin(Math.min(Math.max(v, 0), 1)), 0), 1) * 255).toString(16).padStart(2, '0')).join('');
}
const STOPS = LEVELS.map((l) => oklch(l.color));

/// Colour for a score in 0..2, interpolated in OKLCH through the three button colours.
/// `faded` (a single report) draws it at 60% chroma so one tap looks less certain than five.
export function scoreColor(score, faded = false) {
  const x = Math.min(Math.max(score, 0), 2);
  const k = Math.min(Math.floor(x), 1); const f = x - k;
  const [L0, C0, h0] = STOPS[k]; const [L1, C1, h1] = STOPS[k + 1];
  let dh = h1 - h0;
  if (dh > Math.PI) dh -= 2 * Math.PI; else if (dh < -Math.PI) dh += 2 * Math.PI;
  return hexOf([L0 + (L1 - L0) * f, (C0 + (C1 - C0) * f) * (faded ? 0.6 : 1), h0 + dh * f]);
}

/// Fill for a cell from the chain's aggregate, or neutral grey with no reports.
export const cellColor = (c, basis = 'opinion') => (c && c.n > 0 ? scoreColor(scoreOf(basis === 'grade' ? c.grade : c.opinion, c.n), c.n === 1) : NO_DATA);

export const cellHex =(i) => '0x' + i.toString(16).padStart(64, '0');

/// One of the four middle cells: what is pre-selected when the phone cannot say where it is.
export const HOME_ZONE = (ROWS / 2 - 1) * COLS + (COLS / 2 - 1);
