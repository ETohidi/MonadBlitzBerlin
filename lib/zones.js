// The venue grid. 24 coarse zones, 6 columns by 4 rows, laid over the CIC Berlin site.
// A zone id is the only location that ever reaches the chain, so this file is the whole
// mapping between a coordinate and a claim — and the projector draws the same rectangles.
export const CENTRE = { lat: 52.4940, lng: 13.4463 };
export const COLS = 6;
export const ROWS = 4;
export const N = COLS * ROWS;

// ~400 m by ~400 m: coarse enough that a zone is a corner of a hall, fine enough that
// two zones disagreeing about coverage is a real statement.
const HALF_LAT = 0.0018;
const HALF_LNG = 0.0030;

const LAT_STEP = (HALF_LAT * 2) / ROWS;
const LNG_STEP = (HALF_LNG * 2) / COLS;

/// Corners of zone i, west/south/north/east in degrees.
export function zoneRect(i) {
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  const west = CENTRE.lng - HALF_LNG + col * LNG_STEP;
  const north = CENTRE.lat + HALF_LAT - row * LAT_STEP;
  return { west, south: north - LAT_STEP, east: west + LNG_STEP, north };
}

export function zoneCentre(i) {
  const r = zoneRect(i);
  return { lat: (r.north + r.south) / 2, lng: (r.east + r.west) / 2 };
}

const mPer = (lat) => ({ lat: 111320, lng: 111320 * Math.cos((lat * Math.PI) / 180) });

export function distanceM(a, b) {
  const k = mPer((a.lat + b.lat) / 2);
  return Math.hypot((a.lat - b.lat) * k.lat, (a.lng - b.lng) * k.lng);
}

/// Nearest zone, and how far outside it the point actually sat — the attendee is told
/// the truth about a coarse grid rather than being shown a square that implies precision.
export function zoneOf(lat, lng) {
  const p = { lat, lng };
  let best = 0; let bestD = Infinity;
  for (let i = 0; i < N; i++) {
    const d = distanceM(p, zoneCentre(i));
    if (d < bestD) { bestD = d; best = i; }
  }
  return { zone: best, distance: Math.round(bestD) };
}

export const cellHex = (i) => '0x' + i.toString(16).padStart(64, '0');

/// The zone the site's own centre falls in: what we assume when a phone declines to say.
export const HOME_ZONE = zoneOf(CENTRE.lat, CENTRE.lng).zone;
