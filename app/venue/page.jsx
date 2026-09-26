'use client';
import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { zoneRing, zoneCentre, gridRing, CENTRE, N, NO_DATA, WORD, scoreOf, scoreColor, cellColor, CONTRACT_SHORT } from '../../lib/zones.js';
import Cheat from './cheat.jsx';

const ESRI_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ESRI_ATTRIBUTION = 'Powered by <a href="https://www.esri.com">Esri</a> | Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';
const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
// Natural Earth boundaries, fetched at runtime; without them a click inside the box still counts
const COUNTRIES = 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json';
const GERMANY_ID = '276';
const GERMANY_BOX = [5.87, 47.27, 15.04, 55.06];
const BERLIN = [13.405, 52.52];
const CIC = [CENTRE.lng, CENTRE.lat];
const FLY_MS = 2000;
const PANEL = 400;

const BOUNDS = (() => {
  const r = gridRing(); const xs = r.map((p) => p[0]); const ys = r.map((p) => p[1]);
  return [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]];
})();
const VIEW = {
  1: { center: [10, 35], zoom: 1.7, base: 'esri' },
  2: { center: [10.45, 51.1], zoom: 5.4, base: 'osm' },
  3: { center: [13.41, 52.505], zoom: 11.6, base: 'osm' },
  4: { base: 'esri' },
};

/// TopoJSON -> GeoJSON for one object, just enough for polygons.
function topoFeature(topo, objectName, id) {
  const [sx, sy] = topo.transform.scale;
  const [tx, ty] = topo.transform.translate;
  const arcs = topo.arcs.map((a) => { let x = 0; let y = 0; return a.map(([dx, dy]) => [(x += dx) * sx + tx, (y += dy) * sy + ty]); });
  const ring = (idx) => idx.flatMap((i, k) => { const a = i < 0 ? [...arcs[~i]].reverse() : arcs[i]; return k ? a.slice(1) : a; });
  const g = topo.objects[objectName].geometries.find((x) => String(x.id) === id);
  if (!g) return null;
  const coordinates = g.type === 'Polygon' ? g.arcs.map(ring) : g.arcs.map((p) => p.map(ring));
  return { type: 'Feature', properties: {}, geometry: { type: g.type, coordinates } };
}

function zoneData(cells, basis) {
  return {
    type: 'FeatureCollection',
    features: Array.from({ length: N }, (_, i) => {
      const c = cells[i];
      return {
        type: 'Feature',
        properties: { i, has: c ? 1 : 0, color: cellColor(c, basis) },
        geometry: { type: 'Polygon', coordinates: [zoneRing(i)] },
      };
    }),
  };
}

function pin() {
  const el = document.createElement('div');
  el.style.cssText = 'width:22px;height:22px;border-radius:50%;background:#ffd24a;border:3px solid #fff;box-shadow:0 0 0 8px rgba(255,210,74,.35);cursor:pointer';
  return el;
}

// Every text block sits on this, so it reads over pale street tiles and satellite roofs alike.
const RAMP = `linear-gradient(90deg, ${Array.from({ length: 9 }, (_, k) => scoreColor(k / 4)).join(', ')})`;

function countPill() {
  const el = document.createElement('div');
  el.style.cssText = 'background:rgba(0,0,0,.6);color:#fff;border-radius:8px;padding:0 5px;font:700 11px/16px system-ui;pointer-events:none';
  return el;
}

const box = { background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)', borderRadius: 14, padding: '14px 18px', color: '#fff' };

const PANELS = {
  8: {
    heading: 'A map with no owner',
    cards: [
      ['Nobody can edit it. Not us.', 'The contract has no owner, no pause button, no upgrade switch.'],
      ['Your phone is the signer.', "No wallet, no app, no token. The contract checks the phone's own signature for 6,900 gas."],
      ['On the map before the phone is in your pocket.', 'A block every 0.3 seconds on Monad.'],
      ['Anyone can read it without asking us.', 'The map is contract storage, not our database. 24 cells in 28 ms.'],
    ],
  },
  9: {
    heading: 'Same contract, other questions',
    cards: [
      ['Is there really 5G here?', 'Coverage maps are published by the operators. Phones that were there sign what they got.'],
      ['Did the bus actually come?', 'The phone at the stop signs the time it arrived.'],
      ['How long is the line at BER, really?', 'The phone signs when it joined and when it cleared.'],
      ['Is this street as clean as the city says?', 'A photo, scored by a model, signed by the phone that took it.'],
      ['How loud is it under the flight path at night?', "The phone's microphone, signed, at 3 a.m."],
      ['Was the earthquake alert real?', "A thousand phones' accelerometers, signed, not one agency's press release."],
    ],
    footer: 'Paid for by whoever needs to be believed.',
  },
};

export default function Venue() {
  const holder = useRef(null);
  const mapRef = useRef(null);
  const stRef = useRef(null);
  const stage = useRef(1);
  const basisRef = useRef('opinion');
  const fallback = useRef(false);
  const goRef = useRef(() => {});
  const [view, setView] = useState(1);
  const [st, setSt] = useState(null);
  const [basis, setBasis] = useState('opinion');
  const [hover, setHover] = useState(null);
  const [notice, setNotice] = useState('');
  const [origin, setOrigin] = useState('');
  const [panel, setPanel] = useState(null);
  const panelRef = useRef(null);

  const pills = useRef([]);
  const paintZones = () => {
    mapRef.current?.getSource('zones')?.setData(zoneData(stRef.current?.cells ?? {}, basisRef.current));
    pills.current.forEach((m, i) => { m.getElement().textContent = String(stRef.current?.cells?.[i]?.n ?? 0); });
  };

  useEffect(() => {
    setOrigin(location.origin);
    const load = () => fetch('/api/state').then((r) => r.json())
      .then((s) => { if (!s.ok) return; setSt(s); stRef.current = s; paintZones(); })
      .catch(() => {});
    load();
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const map = new maplibregl.Map({
      container: holder.current,
      center: VIEW[1].center, zoom: VIEW[1].zoom,
      attributionControl: false, dragPan: false, scrollZoom: false, boxZoom: false, dragRotate: false,
      keyboard: false, doubleClickZoom: false, touchZoomRotate: false, touchPitch: false,
      style: {
        version: 8,
        // a globe while zoomed out, flat from country scale down
        projection: { type: ['interpolate', ['linear'], ['zoom'], 3.5, 'vertical-perspective', 4.5, 'mercator'] },
        sources: {
          esri: { type: 'raster', tiles: [ESRI_TILES], tileSize: 256, maxzoom: 19, attribution: ESRI_ATTRIBUTION },
          osm: { type: 'raster', tiles: [OSM_TILES], tileSize: 256, maxzoom: 19, attribution: OSM_ATTRIBUTION },
        },
        layers: [
          { id: 'bg', type: 'background', paint: { 'background-color': '#04070a' } },
          { id: 'esri', type: 'raster', source: 'esri', paint: { 'raster-opacity': 1, 'raster-opacity-transition': { duration: 700 } } },
          { id: 'osm', type: 'raster', source: 'osm', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0, 'raster-opacity-transition': { duration: 700 } } },
        ],
      },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.AttributionControl({ compact: false }), 'bottom-right');

    pills.current = Array.from({ length: N }, (_, i) => { const c = zoneCentre(i); return new maplibregl.Marker({ element: countPill() }).setLngLat([c.lng, c.lat]); });
    paintZones();
    const berlin = new maplibregl.Marker({ element: pin() }).setLngLat(BERLIN);
    const cic = new maplibregl.Marker({ element: pin() }).setLngLat(CIC);
    berlin.getElement().addEventListener('click', (e) => { e.stopPropagation(); if (stage.current === 2) goRef.current(3); });
    cic.getElement().addEventListener('click', (e) => { e.stopPropagation(); if (stage.current === 3) goRef.current(4); });

    let base = 'esri';
    const setBase = (want) => {
      if (want === base) return;
      const old = base; base = want;
      map.setLayoutProperty(want, 'visibility', 'visible');
      map.setPaintProperty(want, 'raster-opacity', 1);
      map.setPaintProperty(old, 'raster-opacity', 0);
      setTimeout(() => { if (base !== old) map.setLayoutProperty(old, 'visibility', 'none'); }, 800);
    };
    const show = (ids, on) => ids.forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'));

    let esriOk = 0; let esriErr = 0;
    map.on('sourcedata', (e) => { if (e.sourceId === 'esri' && e.tile) esriOk++; });
    map.on('error', (e) => { if (e.sourceId === 'esri') esriErr++; });
    const watchSatellite = () => {
      const ok0 = esriOk; const err0 = esriErr;
      setTimeout(() => {
        if (stage.current !== 4 || fallback.current) return;
        if (esriOk === ok0 && (esriErr > err0 || !map.isSourceLoaded('esri'))) {
          fallback.current = true;
          setNotice('Satellite tiles failed to load: showing OpenStreetMap at zoom 18');
          setBase('osm');
          map.flyTo({ center: CIC, zoom: 18, duration: FLY_MS });
        }
      }, FLY_MS + 5000);
    };

    const go = (n) => {
      if (n < 1 || n > 4 || !map.isStyleLoaded()) return;
      stage.current = n; setView(n); setHover(null);
      setBase(fallback.current ? 'osm' : VIEW[n].base);
      show(['germany-fill', 'germany-line'], n <= 2);
      show(['zone-fill', 'zone-line'], n === 4);
      if (n === 2) berlin.addTo(map); else berlin.remove();
      if (n === 3) cic.addTo(map); else cic.remove();
      pills.current.forEach((m) => (n === 4 ? m.addTo(map) : m.remove()));
      if (n === 4) {
        const cam = fallback.current ? { center: CIC, zoom: 18 }
          : map.cameraForBounds(BOUNDS, { padding: { top: 120, bottom: 50, left: 230, right: PANEL + 20 }, maxZoom: 20 });
        map.flyTo({ ...cam, bearing: 0, pitch: 0, duration: FLY_MS, essential: true });
        if (!fallback.current) watchSatellite();
      } else {
        map.flyTo({ center: VIEW[n].center, zoom: VIEW[n].zoom, bearing: 0, pitch: 0, duration: FLY_MS, essential: true });
      }
    };
    goRef.current = go;

    let raf = 0;
    let outlined = false;
    map.on('load', () => {
      map.addSource('germany', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'germany-fill', type: 'fill', source: 'germany', paint: { 'fill-color': '#ffd24a', 'fill-opacity': 0.35 } });
      map.addLayer({ id: 'germany-line', type: 'line', source: 'germany', paint: { 'line-color': '#ffd24a', 'line-width': 2.5 } });
      map.addSource('zones', { type: 'geojson', data: zoneData(stRef.current?.cells ?? {}, basisRef.current) });
      map.addLayer({ id: 'zone-fill', type: 'fill', source: 'zones', layout: { visibility: 'none' },
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['case', ['==', ['get', 'has'], 1], 0.62, 0.3] } });
      map.addLayer({ id: 'zone-line', type: 'line', source: 'zones', layout: { visibility: 'none' },
        paint: { 'line-color': '#ffffff', 'line-width': 1.5, 'line-opacity': 0.8 } });

      fetch(COUNTRIES).then((r) => r.json()).then((topo) => {
        const de = topoFeature(topo, 'countries', GERMANY_ID);
        if (de) { map.getSource('germany').setData({ type: 'FeatureCollection', features: [de] }); outlined = true; }
      }).catch(() => {});

      const spin = () => {
        if (stage.current === 1 && !map.isEasing()) {
          const c = map.getCenter();
          map.setCenter([c.lng + 0.035, c.lat]);
        }
        raf = requestAnimationFrame(spin);
      };
      spin();
    });

    map.on('click', (e) => {
      if (stage.current !== 1) return;
      const hit = map.queryRenderedFeatures(e.point, { layers: ['germany-fill'] }).length > 0;
      const [w, s, east, n] = GERMANY_BOX;
      const inBox = e.lngLat.lng >= w && e.lngLat.lng <= east && e.lngLat.lat >= s && e.lngLat.lat <= n;
      if (hit || (!outlined && inBox)) go(2);
    });
    map.on('mousemove', 'zone-fill', (e) => setHover(e.features?.[0]?.properties?.i ?? null));
    map.on('mouseleave', 'zone-fill', () => setHover(null));

    const showPanel = (p) => { panelRef.current = p; setPanel(p); };
    const onKey = (e) => {
      if (e.key === '8' || e.key === '9') showPanel(Number(e.key));
      else if (e.key === 'Escape' && panelRef.current) showPanel(null);
      else if (e.key >= '1' && e.key <= '4') { showPanel(null); go(Number(e.key)); }
      else if (e.key === 'Escape' && stage.current > 1) go(stage.current - 1);
      else if (e.key === 'm' || e.key === 'M') {
        basisRef.current = basisRef.current === 'opinion' ? 'grade' : 'opinion';
        setBasis(basisRef.current); paintZones();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); cancelAnimationFrame(raf); map.remove(); mapRef.current = null; };
  }, []);

  const cells = st?.cells ?? {};
  const h = hover != null ? cells[hover] : null;

  return (
    <main style={{ position: 'fixed', inset: 0, background: '#04070a' }}>
      <div ref={holder} style={{ position: 'absolute', inset: 0 }} />

      <header style={{ position: 'absolute', top: 16, left: view === 4 ? 220 : 0, right: view === 4 ? PANEL : 0, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
        <div style={{ ...box, textAlign: 'center', padding: '12px 26px' }}>
          <div style={{ fontSize: 44, fontWeight: 800, lineHeight: 1.1 }}>Ground Truth</div>
          <div style={{ fontSize: 21, color: '#dfe7ee' }}>Reported by everyone, edited by no one.</div>
        </div>
      </header>

      {notice && (
        <div style={{ ...box, position: 'absolute', top: 132, left: '50%', transform: 'translateX(-50%)', color: '#f2a516', fontSize: 17 }}>{notice}</div>
      )}

      {view === 4 && (
        <>
          <div style={{ ...box, position: 'absolute', top: 16, left: 16, fontSize: 16 }}>
            <div style={{ width: 220, height: 14, borderRadius: 4, background: RAMP }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', width: 220, marginTop: 4 }}><span>poor</span><span>ok</span><span>excellent</span></div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <span style={{ width: 20, height: 12, borderRadius: 3, background: NO_DATA }} />no reports
            </div>
            <div style={{ color: '#c9d4de', fontSize: 14, marginTop: 6 }}>
              unweighted mean · faded = 1 report{basis === 'grade' ? ' · measured grade' : ''}
            </div>
          </div>

          {hover != null && (
            <div style={{ ...box, position: 'absolute', left: 16, bottom: 76, fontSize: 16 }}>
              <b>Zone {hover + 1}</b>{' '}
              {h ? (
                <>
                  · {h.n} report{h.n === 1 ? '' : 's'}
                  <div>tapped: {scoreOf(h.opinion, h.n).toFixed(1)} · measured: {scoreOf(h.grade, h.n).toFixed(1)} · worst {WORD[h.worst]}</div>
                  <div style={{ color: '#c9d4de', fontSize: 13 }}>unweighted mean, poor 0 · ok 1 · excellent 2</div>
                </>
              ) : '· no reports'}
            </div>
          )}

          <aside style={{ position: 'absolute', top: 16, right: 16, width: PANEL - 60, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {origin && (
              <img src={`/api/qr?target=${encodeURIComponent(origin)}`} width={240} height={240}
                style={{ background: '#fff', borderRadius: 12, padding: 6, alignSelf: 'center' }} alt="Scan to report" />
            )}
            <div style={{ ...box, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontSize: 15 }}>
              <span><b>{st?.devices ?? '–'}</b> phones</span>
              <span><b>{st?.totalAccepted ?? '–'}</b> readings onchain</span>
              <span style={{ color: '#ffb4a8' }}><b>{st?.totalRejected ?? '–'}</b> refused</span>
              <span><b>{st?.secondsPerBlock ?? '–'}</b> s per block</span>
              <span style={{ gridColumn: '1 / -1', color: '#c9d4de' }}>6,900 gas per signature check</span>
            </div>
            <div style={box}><Cheat fontSize={15} /></div>
          </aside>
        </>
      )}

      <footer style={{ ...box, position: 'absolute', left: 16, bottom: 16, padding: '8px 14px', fontSize: 14, color: '#c9d4de' }}>
        Powered by Monad testnet · block {st?.head ?? '–'} · contract {CONTRACT_SHORT}
      </footer>

      {panel && (
        <section style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4vh', padding: '5vh 5vw', boxSizing: 'border-box', overflow: 'hidden', color: '#fff' }}>
          <div style={{ fontSize: 'min(7vh, 4.4vw)', fontWeight: 800, lineHeight: 1.1, textAlign: 'center' }}>{PANELS[panel].heading}</div>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${PANELS[panel].cards.length > 4 ? 3 : 2}, 1fr)`, gap: '2.4vh 1.6vw', width: '100%', maxWidth: PANELS[panel].cards.length > 4 ? '90vw' : '76vw' }}>
            {PANELS[panel].cards.map(([large, small]) => (
              <div key={large} style={{ background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.14)', borderRadius: 18, padding: '3.2vh 1.8vw' }}>
                <div style={{ fontSize: PANELS[panel].cards.length > 4 ? 'min(4vh, 2.3vw)' : 'min(4.8vh, 2.8vw)', fontWeight: 800, lineHeight: 1.15 }}>{large}</div>
                <div style={{ fontSize: PANELS[panel].cards.length > 4 ? 'min(2.6vh, 1.5vw)' : 'min(3vh, 1.8vw)', lineHeight: 1.35, marginTop: '1.4vh', color: '#d5dee6' }}>{small}</div>
              </div>
            ))}
          </div>
          {PANELS[panel].footer && <div style={{ fontSize: 'min(3.6vh, 2.2vw)', fontWeight: 700, textAlign: 'center' }}>{PANELS[panel].footer}</div>}
        </section>
      )}
    </main>
  );
}
