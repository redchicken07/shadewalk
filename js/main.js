/* main.js — 그늘길 앱 부트스트랩: 지도, 그림자 오버레이, UI 전체 배선 */
(function () {
  const U = SW.util;

  // ───────────────────────── 상태 ─────────────────────────
  const state = SW.state = {
    data: null, dataBBox: null, regionId: null,
    defaultH: 10, alpha: 1.32, speedKmh: 4.5,
    showShadow: true,
    timeOffsetMin: 0,
    from: null, to: null, courseStart: null, // {ll,label}
    markers: {},
    pickMode: null,       // 'from' | 'to' | 'course'
    routeOpts: null,      // [{key,label,route,...}]
    selOpt: 0,
    snaps: null,          // {s,t}
    courses: null, selCourse: -1,
    courseMin: 30,
    playing: false,
    busy: false,
  };

  // 경로 3종 — 같은 출발/도착을 서로 다른 기준으로 계산해 비교시킨다
  const ROUTE_MODES = [
    { key: 'short', label: '최단 경로',   emoji: '⚡', color: '#64748b', alpha: 0,    coverPref: 0,    desc: '가장 빨리' },
    { key: 'shade', label: '그늘 경로',   emoji: '🌳', color: '#0f766e', alpha: 1.7,  coverPref: 0.3,  desc: '해를 피해' },
    { key: 'under', label: '지하도 경로', emoji: '🚇', color: '#7c3aed', alpha: 1.2,  coverPref: 1.8,  desc: '지하로 최대한' },
  ];

  const MAX_STRAIGHT = 4000;   // 도보 경로 최대 직선거리 (m)

  const $ = U.el;
  const currentDate = () => new Date(Date.now() + state.timeOffsetMin * 60000);
  const speedMs = () => state.speedKmh / 3.6;
  const tick = () => U.yieldToUI();

  // ───────────────────────── 지도 ─────────────────────────
  const map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: {
        carto: {
          type: 'raster',
          tiles: ['a', 'b', 'c', 'd'].map(s => `https://${s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png`),
          tileSize: 256,
          attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors © <a href="https://carto.com/" target="_blank">CARTO</a>',
        },
      },
      layers: [{ id: 'base', type: 'raster', source: 'carto' }],
    },
    center: [126.9784, 37.5665], // 서울시청 부근
    zoom: 15.6, minZoom: 11, maxZoom: 19,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  // 그림자 오버레이 캔버스 (지도 위 DOM 캔버스, 매 프레임 재투영)
  const shadowCanvas = document.createElement('canvas');
  shadowCanvas.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:1';
  map.getContainer().appendChild(shadowCanvas);

  let rafPending = false;
  function redrawShadow() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; drawShadowNow(); });
  }

  // 겹쳐 그려도 진해지지 않게, 먼저 불투명하게 그린 뒤 한 번만 반투명 합성한다.
  const offCanvas = document.createElement('canvas');

  // 한 경로에 서브패스를 수만 개 쌓으면 브라우저가 급격히 느려진다
  // (강남 도심 한 화면 = 그림자 조각 약 17,000개 → 통짜로 그리면 1.5초, 나눠 그리면 20ms대).
  const FILL_CHUNK = 128;

  function drawShadowNow() {
    const cont = map.getContainer();
    const w = cont.clientWidth, h = cont.clientHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (shadowCanvas.width !== w * dpr || shadowCanvas.height !== h * dpr) {
      shadowCanvas.width = w * dpr; shadowCanvas.height = h * dpr;
      shadowCanvas.style.width = w + 'px'; shadowCanvas.style.height = h + 'px';
    }
    const ctx = shadowCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, w, h);
    if (!state.showShadow || !state.data || !SW.shadow.proj) return;

    const set = SW.shadow.getSet(currentDate());
    if (!set) return;
    if (set.full) { // 밤 또는 해가 아주 낮음 → 전면 그늘
      ctx.fillStyle = set.night ? 'rgba(23,30,60,0.35)' : 'rgba(30,41,82,0.28)';
      ctx.fillRect(0, 0, w, h);
      return;
    }
    const b = map.getBounds();
    const proj = SW.shadow.proj;
    const p0 = proj.toM([b.getWest(), b.getSouth()]);
    const p1 = proj.toM([b.getEast(), b.getNorth()]);
    const view = SW.shadow.viewPolys(set, [p0[0], p0[1], p1[0], p1[1]]);
    if (!view || !view.idx.size) return;

    if (offCanvas.width !== w * dpr || offCanvas.height !== h * dpr) {
      offCanvas.width = w * dpr; offCanvas.height = h * dpr;
    }
    const oc = offCanvas.getContext('2d');
    oc.setTransform(dpr, 0, 0, dpr, 0, 0);
    oc.clearRect(0, 0, w, h);
    oc.fillStyle = '#1e2952';

    // 로컬 미터 → 화면 픽셀. 기울기(pitch)가 없으면 아핀 변환이라 기준점 3개로 끝난다
    // (지도를 회전해도 유효). 꼭짓점마다 map.project를 부르는 것보다 훨씬 빠르다.
    const affine = map.getPitch() === 0;
    let ox, oy, kxx, kxy, kyx, kyy;
    if (affine) {
      const o = map.project(proj.toLL([0, 0]));
      const ex = map.project(proj.toLL([1000, 0]));
      const ey = map.project(proj.toLL([0, 1000]));
      ox = o.x; oy = o.y;
      kxx = (ex.x - o.x) / 1000; kxy = (ex.y - o.y) / 1000;
      kyx = (ey.x - o.x) / 1000; kyy = (ey.y - o.y) / 1000;
    }

    let inPath = 0;
    oc.beginPath();
    for (const i of view.idx) {
      const ring = view.polys[i];
      for (let k = 0; k < ring.length; k++) {
        let x, y;
        if (affine) {
          const mx = ring[k][0], my = ring[k][1];
          x = ox + mx * kxx + my * kyx;
          y = oy + mx * kxy + my * kyy;
        } else {
          const pt = map.project(proj.toLL(ring[k]));
          x = pt.x; y = pt.y;
        }
        if (k === 0) oc.moveTo(x, y); else oc.lineTo(x, y);
      }
      oc.closePath();
      if (++inPath >= FILL_CHUNK) { oc.fill(); oc.beginPath(); inPath = 0; }
    }
    if (inPath) oc.fill();

    ctx.globalAlpha = 0.32;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(offCanvas, 0, 0);
    ctx.globalAlpha = 1;
  }

  map.on('move', redrawShadow);
  map.on('resize', redrawShadow);
  map.on('moveend', () => { redrawShadow(); updateReloadBtn(); });

  // 경로 레이어. 타일 서버가 막히면 'load'가 영영 안 오기 때문에
  // 스타일만 준비되면 레이어를 깔고, 그래도 소식이 없으면 타이머로 앱을 띄운다.
  let layersReady = false, booted = false;

  function addRouteLayers() {
    if (layersReady || !map.getStyle()) return false;
    try {
      map.addSource('alt', { type: 'geojson', data: emptyFC() });
    map.addSource('route', { type: 'geojson', data: emptyFC() });
    map.addSource('conn', { type: 'geojson', data: emptyFC() });

    map.addLayer({ id: 'alt-casing', type: 'line', source: 'alt',
      paint: { 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.75 },
      layout: { 'line-cap': 'round', 'line-join': 'round' } });
    map.addLayer({ id: 'alt-line', type: 'line', source: 'alt',
      paint: { 'line-color': '#94a3b8', 'line-width': 3.5, 'line-dasharray': [1.4, 1.4], 'line-opacity': 0.95 },
      layout: { 'line-cap': 'round', 'line-join': 'round' } });
    map.addLayer({ id: 'route-casing', type: 'line', source: 'route',
      paint: { 'line-color': '#ffffff', 'line-width': 8.5, 'line-opacity': 0.9 },
      layout: { 'line-cap': 'round', 'line-join': 'round' } });
    map.addLayer({ id: 'route-sun', type: 'line', source: 'route', filter: ['==', ['get', 'state'], 'sun'],
      paint: { 'line-color': '#f59e0b', 'line-width': 5 },
      layout: { 'line-cap': 'round', 'line-join': 'round' } });
    map.addLayer({ id: 'route-shade', type: 'line', source: 'route', filter: ['==', ['get', 'state'], 'shade'],
      paint: { 'line-color': '#0f766e', 'line-width': 5 },
      layout: { 'line-cap': 'round', 'line-join': 'round' } });
    map.addLayer({ id: 'route-cov', type: 'line', source: 'route', filter: ['==', ['get', 'state'], 'covered'],
      paint: { 'line-color': '#8b5cf6', 'line-width': 5, 'line-dasharray': [0.2, 1.6] },
      layout: { 'line-cap': 'round', 'line-join': 'round' } });
      map.addLayer({ id: 'conn-line', type: 'line', source: 'conn',
        paint: { 'line-color': '#64748b', 'line-width': 2, 'line-dasharray': [0.5, 2] },
        layout: { 'line-cap': 'round' } });
      layersReady = true;
      return true;
    } catch (e) {
      console.warn('경로 레이어 준비 지연', e);
      return false;
    }
  }

  function boot() {
    addRouteLayers();
    if (booted) return;
    booted = true;
    initialLoad();
  }

  map.on('load', boot);
  map.on('style.load', addRouteLayers);
  // 타일이 차단된 환경(오프라인·사내망)에서도 앱이 멈추지 않도록 하는 안전장치
  setTimeout(() => {
    if (booted) return;
    console.warn('지도 타일 응답이 없어 폴백으로 시작합니다');
    toast('지도 타일을 불러오지 못했어요. 배경 지도 없이 계속 진행할게요.', 6000);
    boot();
  }, 8000);

  let tileErrShown = false;
  map.on('error', (e) => {
    if (tileErrShown) return;
    tileErrShown = true;
    console.warn('지도 오류', e && e.error);
  });

  function emptyFC() { return { type: 'FeatureCollection', features: [] }; }

  // 레이어가 아직(또는 끝내) 준비되지 않아도 계산 결과 표시가 깨지지 않게
  function setSrc(id, data) {
    if (!layersReady) addRouteLayers();
    const s = map.getSource(id);
    if (s) s.setData(data);
  }

  // ───────────────────────── 데이터 로드 ─────────────────────────
  function bboxContains(o, i) {
    return o[0] <= i[0] && o[1] <= i[1] && o[2] >= i[2] && o[3] >= i[3];
  }
  function bboxAround(lls, padM) {
    let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
    for (const ll of lls) {
      if (ll[1] < s) s = ll[1]; if (ll[1] > n) n = ll[1];
      if (ll[0] < w) w = ll[0]; if (ll[0] > e) e = ll[0];
    }
    const midLat = (s + n) / 2;
    const dLat = padM / 111132;
    const dLng = padM / (111320 * Math.cos(midLat * Math.PI / 180));
    return [s - dLat, w - dLng, n + dLat, e + dLng];
  }

  /** 미리 구워 둔 지역 하나를 통째로 올린다 (실행 중 외부 API 호출 없음) */
  async function loadRegion(id, opts) {
    opts = opts || {};
    if (state.regionId === id && state.data) return state.data;
    busy(true, '지역 데이터 불러오는 중…');
    try {
      const data = await SW.regions.load(id, msg => busyMsg(msg));
      state.data = data;
      state.regionId = id;
      state.dataBBox = data.bbox;
      // 강남만 해도 건물의 76%가 OSM에 높이 정보가 없다. 그런 건물은 굽는 단계에서
      // 높이 0으로 남겨 두고, 사용자가 고른 "기본 건물 높이"를 여기서 입힌다.
      SW.osm.applyDefaultHeight(data, state.defaultH);
      busyMsg('그림자 엔진 준비 중…');
      await tick();
      SW.shadow.setData(data);
      SW.graph.build(data);
      redrawShadow();
      updateDataInfo();
      updateRegionLabel();
      try { localStorage.setItem('shadewalk.region', id); } catch (e) { /* 시크릿 모드 */ }
      const reg = SW.regions.get(id);
      if (reg && opts.fly !== false) {
        map.flyTo({ center: reg.c, zoom: 15.2, duration: opts.instant ? 0 : 900 });
      }
      updateReloadBtn();
      return data;
    } finally {
      busy(false);
    }
  }

  /** 필요한 범위가 현재 지역 밖이면, 그 범위를 품는 지역으로 갈아탄다 */
  async function ensureData(need) {
    if (state.dataBBox && bboxContains(state.dataBBox, need)) return;
    const mid = [(need[1] + need[3]) / 2, (need[0] + need[2]) / 2];
    const reg = SW.regions.containing(mid);
    if (reg && reg.id !== state.regionId) {
      await loadRegion(reg.id, { fly: false });
      if (bboxContains(state.dataBBox, need)) return;
    }
    throw { user: '두 지점이 한 지역 안에 들어오지 않아요. 같은 지역 안에서 잡아 주세요.' };
  }

  async function initialLoad() {
    updateTimeLabel();
    try {
      busy(true, '지역 목록 불러오는 중…');
      await SW.regions.loadIndex();
      buildRegionList();
    } catch (e) {
      console.error(e);
      toast('지역 목록을 불러오지 못했어요. 새로고침해 주세요.', 8000);
      return;
    } finally {
      busy(false);
    }

    // 우선순위: URL의 ?region= → 지난번에 보던 지역 → 현재 위치에서 가까운 곳 → 강남
    const url = new URLSearchParams(location.search).get('region');
    let saved = null;
    try { saved = localStorage.getItem('shadewalk.region'); } catch (e) { /* 시크릿 모드 */ }
    let pick = (url && SW.regions.get(url)) || (saved && SW.regions.get(saved));

    if (!pick) {
      const here = await tryGeolocate(3500);
      const near = here && SW.regions.nearest(here);
      if (near) {
        pick = near.region;
        if (near.km > 12) {
          toast(`가까운 지원 지역이 ${near.region.name}(약 ${Math.round(near.km)}km)이에요. 다른 곳은 📍에서 고를 수 있어요.`, 7000);
        }
      }
    }
    if (!pick) pick = SW.regions.get('sel-gbd') || SW.regions.list()[0];
    if (!pick) { toast('사용 가능한 지역이 없어요.', 8000); return; }

    try {
      await loadRegion(pick.id, { instant: true });
      toast(`${pick.name} 준비 완료 — 지도를 클릭하면 건물 그림자 정보가 나와요 🌳`, 5000);
    } catch (e) {
      console.error(e);
      toast('지역 데이터를 불러오지 못했어요. 새로고침해 주세요.', 8000);
    }
  }

  function tryGeolocate(ms) {
    return new Promise(res => {
      if (!navigator.geolocation) return res(null);
      let done = false;
      const fin = (v) => { if (!done) { done = true; res(v); } };
      setTimeout(() => fin(null), ms);
      navigator.geolocation.getCurrentPosition(
        p => fin([p.coords.longitude, p.coords.latitude]),
        () => fin(null),
        { timeout: ms, maximumAge: 600000 });
    });
  }

  function updateDataInfo(poiCount) {
    const d = state.data;
    if (!d) return;
    const c = SW.graph.counts();
    const poi = poiCount || (d.pois ? d.pois.length : 0);
    $('data-info').textContent =
      `건물 ${d.buildings.length.toLocaleString()} · 보행 구간 ${c.edges.toLocaleString()} · 나무 ${d.trees.length.toLocaleString()}`
      + (poi ? ` · 장소 ${poi.toLocaleString()}` : '');
  }

  // ───────────────────────── 지역 선택 ─────────────────────────
  function updateRegionLabel() {
    const reg = SW.regions.get(state.regionId);
    $('region-label').textContent = reg ? `${reg.city} · ${reg.name}` : '지역 선택';
  }

  function buildRegionList(filter) {
    const wrap = $('region-list');
    const q = (filter || '').trim().toLowerCase();
    wrap.innerHTML = '';
    let shown = 0;

    for (const [city, regs] of SW.regions.byCity()) {
      const hits = regs.filter(r => !q ||
        (city + r.name + r.sub).toLowerCase().includes(q));
      if (!hits.length) continue;

      const h = document.createElement('div');
      h.className = 'region-city';
      h.textContent = city;
      wrap.appendChild(h);

      for (const r of hits) {
        shown++;
        const it = document.createElement('button');
        it.className = 'region-item' + (r.id === state.regionId ? ' sel' : '');
        it.innerHTML = `<b>${escapeHtml(r.name)}</b><small>${escapeHtml(r.sub)}</small>`;
        it.addEventListener('click', async () => {
          $('region-pop').classList.add('hidden');
          if (r.id === state.regionId) { map.flyTo({ center: r.c, zoom: 15.2, duration: 700 }); return; }
          try {
            clearResults();
            await loadRegion(r.id);
            toast(`${r.name}로 이동했어요 🌳`);
          } catch (e) {
            console.error(e);
            toast('지역 데이터를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.', 7000);
          }
        });
        wrap.appendChild(it);
      }
    }
    if (!shown) wrap.innerHTML = '<div class="region-empty">검색 결과가 없어요</div>';
  }

  $('btn-region').addEventListener('click', () => {
    const pop = $('region-pop');
    const opening = pop.classList.contains('hidden');
    pop.classList.toggle('hidden');
    if (opening) {
      $('settings-pop').classList.add('hidden');
      $('inp-region-filter').value = '';
      buildRegionList();
      $('inp-region-filter').focus();
    }
  });
  $('inp-region-filter').addEventListener('input', () => buildRegionList($('inp-region-filter').value));

  /** 지도 중심이 현재 지역을 벗어나면 "가까운 지역으로" 버튼을 띄운다 */
  function updateReloadBtn() {
    const btn = $('btn-reload');
    if (!state.dataBBox) { btn.classList.add('hidden'); return; }
    const c = map.getCenter();
    const inX = c.lat >= state.dataBBox[0] && c.lat <= state.dataBBox[2] &&
                c.lng >= state.dataBBox[1] && c.lng <= state.dataBBox[3];
    btn.classList.toggle('hidden', inX);
  }

  $('btn-reload').addEventListener('click', async () => {
    const c = map.getCenter();
    const ll = [c.lng, c.lat];
    const inside = SW.regions.containing(ll);
    const near = inside ? { region: inside, km: 0 } : SW.regions.nearest(ll);
    if (!near) { toast('사용 가능한 지역이 없어요.'); return; }
    if (near.region.id === state.regionId) {
      map.flyTo({ center: near.region.c, zoom: 15.2, duration: 700 });
      return;
    }
    try {
      clearResults();
      await loadRegion(near.region.id);
      toast(`${near.region.name} 데이터로 바꿨어요 🌳`);
    } catch (e) {
      console.error(e);
      toast('지역 데이터를 불러오지 못했어요.', 7000);
    }
  });

  /** 지역을 바꾸면 이전 지역 기준으로 계산된 경로·코스는 의미가 없다 */
  function clearResults() {
    state.routeOpts = null; state.courses = null; state.selCourse = -1;
    setSrc('route', emptyFC()); setSrc('alt', emptyFC()); setSrc('conn', emptyFC());
    $('route-result').classList.add('hidden');
    $('course-cards').innerHTML = '';
  }

  // ───────────────────────── 마커/지점 ─────────────────────────
  const MARKER_COLOR = { from: '#0d9488', to: '#ef4444', course: '#3b82f6' };

  function setPoint(kind, ll, label, opts) {
    opts = opts || {};
    const key = kind === 'course' ? 'courseStart' : kind;
    state[key] = { ll, label };
    const inp = $(kind === 'from' ? 'inp-from' : kind === 'to' ? 'inp-to' : 'inp-course');
    inp.value = label;

    if (state.markers[kind]) state.markers[kind].remove();
    const mk = new maplibregl.Marker({ color: MARKER_COLOR[kind], draggable: true })
      .setLngLat(ll).addTo(map);
    mk.getElement().style.zIndex = 5;
    mk.on('dragend', () => {
      const p = mk.getLngLat();
      state[key] = { ll: [p.lng, p.lat], label: '지도 지점' };
      inp.value = '지도 지점';
      if (kind !== 'course' && state.from && state.to) scheduleRoute();
    });
    state.markers[kind] = mk;

    if (opts.fly) map.flyTo({ center: ll, zoom: Math.max(map.getZoom(), 15.2), duration: 700 });
    if (kind !== 'course' && state.from && state.to && !opts.noRoute) scheduleRoute();
  }

  // 지도 클릭: 지점 선택 모드 or 건물 정보
  map.on('click', (ev) => {
    const ll = [ev.lngLat.lng, ev.lngLat.lat];
    if (state.pickMode) {
      const kind = state.pickMode;
      setPickMode(null);
      setPoint(kind, ll, '지도에서 선택한 지점');
      return;
    }
    showBuildingPopup(ll);
  });

  function showBuildingPopup(ll) {
    if (!SW.shadow.proj) return;
    const b = SW.shadow.buildingAt(ll);
    if (!b) return;
    const t = b.tags || {};
    const name = t.name || '이름 없는 건물';
    const levels = t['building:levels'];
    const measured = !!(t.height || t['building:height']);
    const hSrc = measured ? '실측값' : (levels ? '층수 기반 추정' : '기본값 추정');
    const su = SW.sun.shadowUnit(currentDate(), SW.shadow.origin[1], SW.shadow.origin[0]);
    let shadowTxt;
    if (su.night) shadowTxt = '지금은 해가 져 있어요 🌙';
    else {
      const len = Math.min(320, Math.hypot(su.ux, su.uy) * b.h);
      shadowTxt = `지금 그림자 길이 약 <b>${Math.round(len)}m</b> (태양고도 ${su.altDeg.toFixed(0)}°)`;
    }
    new maplibregl.Popup({ closeButton: true, maxWidth: '260px' })
      .setLngLat(ll)
      .setHTML(`<div class="bld-pop"><h4>🏢 ${escapeHtml(name)}</h4>
        <p>높이 약 <b>${Math.round(b.h)}m</b>${levels ? ` · ${levels}층` : ''} <small>(${hSrc})</small><br>${shadowTxt}</p></div>`)
      .addTo(map);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function setPickMode(mode) {
    state.pickMode = mode;
    ['from', 'to', 'course'].forEach(k => {
      const btn = $('btn-pick-' + k);
      if (btn) btn.classList.toggle('on', mode === k);
    });
    map.getContainer().classList.toggle('picking', !!mode);
    if (mode) toast('지도를 클릭해 위치를 지정해 주세요');
  }

  ['from', 'to', 'course'].forEach(k => {
    $('btn-pick-' + k).addEventListener('click', () =>
      setPickMode(state.pickMode === k ? null : k));
  });

  // 현재 위치
  function geolocate(kind) {
    if (!navigator.geolocation) { toast('이 브라우저는 위치 기능을 지원하지 않아요'); return; }
    navigator.geolocation.getCurrentPosition(
      p => setPoint(kind, [p.coords.longitude, p.coords.latitude], '현재 위치', { fly: true }),
      () => toast('현재 위치를 가져오지 못했어요 (HTTPS로 열어야 동작해요)'),
      { enableHighAccuracy: true, timeout: 8000 });
  }
  $('btn-geo-from').addEventListener('click', () => geolocate('from'));
  $('btn-geo-course').addEventListener('click', () => geolocate('course'));

  // 스왑
  $('btn-swap').addEventListener('click', () => {
    const f = state.from, t = state.to;
    if (!f && !t) return;
    if (t) setPoint('from', t.ll, t.label, { noRoute: true }); else { state.from = null; $('inp-from').value = ''; if (state.markers.from) state.markers.from.remove(); }
    if (f) setPoint('to', f.ll, f.label, { noRoute: true }); else { state.to = null; $('inp-to').value = ''; if (state.markers.to) state.markers.to.remove(); }
    if (state.from && state.to) scheduleRoute();
  });

  // ───────────────────────── 장소 검색 ─────────────────────────
  function wireSearch(inpId, ddId, kind) {
    const inp = $(inpId), dd = $(ddId);
    let seq = 0;
    const run = async () => {
      const q = inp.value.trim();
      if (q.length < 1) { dd.classList.add('hidden'); return; }
      const my = ++seq;
      dd.classList.remove('hidden');
      const paint = (res, done) => {
        if (my !== seq) return;
        if (!res.length) {
          if (!done) return;
          const reg = SW.regions.get(state.regionId);
          dd.innerHTML = '<div class="dd-empty">이 지역에는 없어요.'
            + (reg ? ` 지금 <b>${escapeHtml(reg.name)}</b> 안에서만 찾고 있어요 — 📍에서 지역을 바꿔 보세요.` : '')
            + '</div>';
          return;
        }
        dd.innerHTML = '';
        res.forEach(r => {
          const it = document.createElement('div');
          it.className = 'dd-item';
          it.title = r.full;
          it.innerHTML =
            `<div class="dd-name"><span>${escapeHtml(r.name)}</span><span class="dd-dist">${r.dist}</span></div>` +
            (r.detail ? `<div class="dd-sub">${escapeHtml(r.detail)}</div>` : '');
          it.addEventListener('click', () => {
            dd.classList.add('hidden');
            setPoint(kind, r.ll, r.name, { fly: true });
          });
          dd.appendChild(it);
        });
      };

      try {
        const c = map.getCenter();
        paint(await SW.geo.search(q, [c.lng, c.lat]), true);
      } catch (e) {
        if (my !== seq) return;
        console.error(e);
        dd.innerHTML = '<div class="dd-empty">검색 중 문제가 생겼어요</div>';
      }
    };
    const debounced = U.debounce(run, 120); // 지역 데이터 안에서 찾으므로 즉시 나온다
    inp.addEventListener('input', debounced);
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        run().then(() => {
          const first = dd.querySelector('.dd-item');
          if (first) first.click();
        });
      }
    });
  }
  wireSearch('inp-from', 'dd-from', 'from');
  wireSearch('inp-to', 'dd-to', 'to');
  wireSearch('inp-course', 'dd-course', 'course');
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.inp-wrap')) {
      document.querySelectorAll('.dropdown').forEach(d => d.classList.add('hidden'));
    }
  });

  // ───────────────────────── 경로 계산 ─────────────────────────
  const scheduleRoute = U.debounce(() => doRoute(), 300);

  async function doRoute() {
    if (!state.from || !state.to || state.busy) return;
    const a = state.from.ll, b = state.to.ll;
    const straight = U.haversine(a, b);
    if (straight < 30) { toast('출발지와 도착지가 너무 가까워요'); return; }
    if (straight > MAX_STRAIGHT) { toast(`도보 경로는 직선거리 약 ${MAX_STRAIGHT / 1000}km 이내에서 지원해요 🙏`); return; }

    busy(true, '경로 준비 중…');
    try {
      await ensureData(bboxAround([a, b], Math.max(250, straight * 0.22)));
      const s = SW.graph.snap(a), t = SW.graph.snap(b);
      if (!s || !t) { toast('주변 보행로 데이터를 찾지 못했어요. 위치를 조금 옮겨 볼까요?'); return; }
      if (s.v === t.v) { toast('두 지점이 같은 길 위에 있어요 — 조금 더 떨어뜨려 주세요'); return; }

      busyMsg('시간대별 그림자로 경로 3가지 계산 중…');
      await tick();
      const depart = currentDate();

      const raw = [];
      for (const m of ROUTE_MODES) {
        const r = SW.graph.route(s.v, t.v, depart, m.alpha, speedMs(), { coverPref: m.coverPref });
        if (r) raw.push({ ...m, route: r });
      }
      if (!raw.length) { toast('경로를 찾지 못했어요 (보행 네트워크가 끊겨 있어요)'); return; }

      // 서로 사실상 같은 경로가 나오면(예: 그늘 최적 경로가 곧 지하도 경로) 카드 하나로 합친다
      const opts = [];
      for (const o of raw) {
        const dup = opts.find(p =>
          Math.abs(p.route.totalLen - o.route.totalLen) < 25 &&
          Math.abs(p.route.shadeFrac - o.route.shadeFrac) < 0.02 &&
          Math.abs(p.route.covLen - o.route.covLen) < 25);
        if (dup) { dup.alsoLabels.push(`${o.emoji} ${o.label}`); continue; }
        opts.push({ ...o, alsoLabels: [] });
      }

      state.routeOpts = opts;
      state.snaps = { s, t };
      state.courses = null; state.selCourse = -1;
      $('course-cards').innerHTML = '';

      // 기본 선택: 그늘이 가장 많은 경로 (동률이면 짧은 쪽)
      let best = 0;
      opts.forEach((o, i) => {
        const b = opts[best];
        if (o.route.shadeFrac > b.route.shadeFrac + 0.015 ||
           (Math.abs(o.route.shadeFrac - b.route.shadeFrac) <= 0.015 && o.route.totalLen < b.route.totalLen)) best = i;
      });
      renderRouteOpts(best, true);
      buildForecast();
    } catch (e) {
      if (e && e.user) toast(e.user);
      else { console.error(e); toast('경로 계산 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.'); }
    } finally {
      busy(false);
    }
  }

  function piecesToFC(pieces) {
    return {
      type: 'FeatureCollection',
      features: pieces.map(p => ({
        type: 'Feature',
        properties: { state: p.state },
        geometry: { type: 'LineString', coordinates: p.ll },
      })),
    };
  }
  function lineFC(coordsList) {
    return {
      type: 'FeatureCollection',
      features: coordsList.map(c => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: c } })),
    };
  }
  function mergePieces(pieces) {
    const out = [];
    for (const p of pieces) {
      const last = out[out.length - 1];
      if (last && last.state === p.state) last.len += p.len;
      else out.push({ state: p.state, len: p.len });
    }
    return out;
  }
  function piecesBounds(pieces) {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const p of pieces) for (const c of p.ll) {
      if (c[0] < w) w = c[0]; if (c[0] > e) e = c[0];
      if (c[1] < s) s = c[1]; if (c[1] > n) n = c[1];
    }
    return [[w, s], [e, n]];
  }
  function fitTo(pieces) {
    const bb = piecesBounds(pieces);
    const desktop = window.innerWidth > 680;
    const panelOpen = !$('panel').classList.contains('collapsed');
    map.fitBounds(bb, {
      padding: { top: 70, bottom: 110, right: 60, left: desktop && panelOpen ? 410 : 40 },
      duration: 700, maxZoom: 17,
    });
  }
  function renderStrip(elId, pieces, totalLen) {
    const elx = $(elId);
    elx.innerHTML = '';
    for (const p of mergePieces(pieces)) {
      const i = document.createElement('i');
      i.className = p.state;
      i.style.width = (p.len / totalLen * 100) + '%';
      elx.appendChild(i);
    }
  }

  function renderRouteOpts(sel, doFit) {
    state.selOpt = sel;
    const opts = state.routeOpts;
    const cur = opts[sel], r = cur.route;
    const { s, t } = state.snaps;

    // 선택 경로는 그늘/햇빛 색으로, 나머지는 옅은 회색 참고선으로
    setSrc('route', piecesToFC(r.pieces));
    setSrc('alt', lineFC(
      opts.filter((o, i) => i !== sel).map(o => [].concat(...o.route.pieces.map(p => p.ll)))
    ));
    setSrc('conn', lineFC([[state.from.ll, s.ll], [t.ll, state.to.ll]]));
    if (doFit) fitTo(r.pieces);

    // 비교 카드
    const wrap = $('route-opts');
    wrap.innerHTML = '';
    const shortest = Math.min(...opts.map(o => o.route.totalLen));
    opts.forEach((o, i) => {
      const rr = o.route;
      const extra = rr.totalLen - shortest;
      const bits = [U.fmtDist(rr.totalLen), U.fmtDur(rr.timeS)];
      if (extra > 20) bits.push(`+${U.fmtDist(extra)}`);
      if (rr.covLen > 20) bits.push(`지하 ${U.fmtDist(rr.covLen)}`);
      const also = o.alsoLabels && o.alsoLabels.length
        ? `<span class="tag">${o.alsoLabels.join(' · ')}와 동일</span>` : '';
      const card = document.createElement('div');
      card.className = 'ropt' + (i === sel ? ' sel' : '');
      card.innerHTML =
        `<span class="ropt-bar" style="background:${o.color}"></span>
         <div class="ropt-main">
           <div class="ropt-title">${o.emoji} ${o.label}${also}</div>
           <div class="ropt-sub">${bits.join(' · ')}</div>
         </div>
         <div class="ropt-shade"><b>${Math.round(rr.shadeFrac * 100)}%</b><span>그늘</span></div>`;
      card.addEventListener('click', () => renderRouteOpts(i, true));
      wrap.appendChild(card);
    });

    $('route-result').classList.remove('hidden');
    renderStrip('rr-strip', r.pieces, r.totalLen);

    const covTxt = r.covLen > 20 ? ` · 지하·실내 ${U.fmtDist(r.covLen)} 포함` : '';
    $('rr-arrive').textContent =
      `🕒 ${U.fmtTime(r.depart)} 출발 → ${U.fmtTime(r.arrive)} 도착 예정${covTxt}`;

    // 최단 대비 무엇을 얻고 무엇을 잃는지 한 줄로
    const base = opts.find(o => o.key === 'short');
    const cmp = $('rr-compare');
    const departSet = SW.shadow.getSet(r.depart);
    if (departSet && departSet.full) {
      cmp.textContent = departSet.night
        ? '🌙 해가 진 시간이라 어디로 걷든 시원해요. 세 경로의 그늘 차이가 없는 게 정상이에요.'
        : '🌥 해가 아주 낮아 사실상 전 구간이 그늘이에요.';
    } else if (!base || cur.key === 'short') {
      const other = opts.filter(o => o.key !== 'short')
        .sort((a, b) => b.route.shadeFrac - a.route.shadeFrac)[0];
      cmp.textContent = other
        ? `💡 ${other.emoji} ${other.label}을 고르면 ${U.fmtDist(other.route.totalLen - r.totalLen)} 더 걷는 대신 그늘이 ${Math.round((other.route.shadeFrac - r.shadeFrac) * 100)}%p 많아져요.`
        : '지금은 최단 경로가 곧 가장 시원한 길이에요 👍';
    } else {
      const dd = r.totalLen - base.route.totalLen;
      const dsh = Math.round((r.shadeFrac - base.route.shadeFrac) * 100);
      const dt = Math.round((r.timeS - base.route.timeS) / 60);
      cmp.textContent = dsh <= 1 && dd < 25
        ? '👍 지금은 최단 경로와 거의 같아요 — 돌아갈 이유가 없네요.'
        : `☂️ 최단 경로보다 ${U.fmtDist(Math.max(0, dd))}${dt >= 1 ? ` (약 ${dt}분)` : ''} 더 걷고, 그늘은 ${dsh}%p 더 많아요.`;
    }
  }

  // ── 출발 시각별 그늘 예보 ────────────────────────────────
  // 지금부터 30분 간격으로 12시간, 선택한 기준의 최적 경로를 다시 풀어 그늘 비율을 본다.
  async function buildForecast() {
    const chart = $('fc-chart'), bestEl = $('fc-best');
    if (!state.routeOpts || !state.snaps) return;
    chart.innerHTML = '<div class="fc-loading">시간대별 그늘을 계산하는 중…</div>';
    bestEl.textContent = '';

    const mode = ROUTE_MODES.find(m => m.key === state.routeOpts[state.selOpt].key) || ROUTE_MODES[1];
    const { s, t } = state.snaps;
    const base = new Date(Date.now() + state.timeOffsetMin * 60000);
    base.setSeconds(0, 0);
    const rows = [];
    const STEP = 30, N = 25;

    for (let i = 0; i < N; i++) {
      const d = new Date(base.getTime() + i * STEP * 60000);
      const r = SW.graph.route(s.v, t.v, d, mode.alpha, speedMs(), { coverPref: mode.coverPref });
      const set = SW.shadow.getSet(d);
      rows.push({
        min: i * STEP, date: d,
        shade: r ? r.shadeFrac : null,
        // 해가 없거나 지평선에 붙은 시간대는 "그늘 100%"가 당연하니 추천에서 제외한다
        dark: !!(set && set.full),
      });
      if (i % 6 === 5) await tick(0); // UI가 멈추지 않게
    }

    const day = rows.filter(x => x.shade !== null && !x.dark);
    const bestRow = day.length ? day.reduce((a, b) => (b.shade > a.shade + 0.005 ? b : a)) : null;
    const firstDark = rows.find(x => x.dark);

    chart.innerHTML = '';
    rows.forEach((x) => {
      const bar = document.createElement('div');
      const isBest = bestRow && x === bestRow;
      bar.className = 'fc-bar' + (x.dark ? ' night' : '') + (isBest ? ' best' : '') + (x.min === 0 ? ' cur' : '');
      const pct = x.shade === null ? 0 : Math.round(x.shade * 100);
      const showLabel = x.date.getMinutes() === 0 && x.date.getHours() % 3 === 0;
      bar.innerHTML = `<i style="height:${Math.max(4, pct * 0.62)}%"></i><em>${showLabel ? x.date.getHours() + '시' : ''}</em>`;
      bar.title = `${U.fmtTime(x.date)} 출발 → 그늘 ${pct}%${x.dark ? ' (해 없음)' : ''}`;
      bar.addEventListener('click', () => {
        $('rng-time').value = String(state.timeOffsetMin + x.min);
        $('rng-time').dispatchEvent(new Event('input'));
      });
      chart.appendChild(bar);
    });

    const nowShade = rows[0].shade;
    // 안내에는 실제 일몰 시각을 쓴다 (그림자 계산의 "해 없음" 기준은 고도 2.5°라 조금 이르다)
    let darkTxt = '';
    if (firstDark && firstDark.min > 0) {
      let sunsetTxt = U.fmtTime(firstDark.date);
      try {
        const c = map.getCenter();
        const ss = SW.sun.times(rows[0].date, c.lat, c.lng).sunset;
        if (ss && ss > rows[0].date) sunsetTxt = U.fmtTime(ss);
      } catch (e) { /* 기본값 사용 */ }
      darkTxt = ` (${sunsetTxt} 일몰 뒤로는 어디로 가도 시원해요 🌙)`;
    }

    if (rows[0].dark) {
      bestEl.textContent = '🌙 지금은 해가 없는 시간이라 어느 길로 가도 시원해요.';
    } else if (!bestRow) {
      bestEl.textContent = '🌙 앞으로 12시간은 해가 거의 없어요 — 언제 나가도 시원합니다.';
    } else if (nowShade !== null && bestRow.shade <= nowShade + 0.03) {
      bestEl.innerHTML = `👍 해가 떠 있는 동안은 <b>지금 출발</b>이 가장 시원해요 (그늘 ${Math.round(nowShade * 100)}%).${darkTxt}`;
    } else {
      const wait = bestRow.min;
      const waitTxt = wait < 60 ? `${wait}분 뒤` : `${Math.floor(wait / 60)}시간 ${wait % 60 ? (wait % 60) + '분 ' : ''}뒤`;
      bestEl.innerHTML = `🕐 <b>${U.fmtTime(bestRow.date)}</b>(${waitTxt})에 나서면 그늘이 <b>${Math.round(bestRow.shade * 100)}%</b>로 가장 많아요.
        지금 출발하면 ${Math.round((nowShade || 0) * 100)}%예요.${darkTxt}`;
    }
  }

  $('btn-route').addEventListener('click', doRoute);

  // ───────────────────────── 산책 코스 ─────────────────────────
  document.querySelectorAll('#course-chips .chip').forEach(ch => {
    ch.addEventListener('click', () => {
      document.querySelectorAll('#course-chips .chip').forEach(c => c.classList.remove('active'));
      ch.classList.add('active');
      state.courseMin = parseInt(ch.dataset.min, 10);
    });
  });

  $('btn-course').addEventListener('click', doCourses);

  async function doCourses() {
    if (state.busy) return;
    const start = state.courseStart ? state.courseStart.ll : [map.getCenter().lng, map.getCenter().lat];
    const startLabel = state.courseStart ? state.courseStart.label : '지도 중심';
    const minutes = state.courseMin;
    const targetL = speedMs() * 60 * minutes;
    const reach = (targetL / 5.8) * 1.45 + 400;

    busy(true, '산책 코스 준비 중…');
    try {
      // 코스는 시작점만 지역 안에 있으면 된다. 반경이 지역 경계를 넘더라도
      // 그 방향 코스만 후보에서 빠질 뿐이라 굳이 막지 않는다.
      await ensureData(bboxAround([start], 30));

      const depart = currentDate();
      const res = await SW.course.recommend(start, minutes, depart, Math.max(state.alpha, 0.8), speedMs(), m => busyMsg(m));
      if (res.err === 'noSnap') { toast('시작점 주변에 보행로 데이터가 없어요'); return; }
      if (!res.courses.length) { toast('코스를 만들지 못했어요 — 위치를 옮기거나 시간을 바꿔 볼까요?'); return; }

      state.courses = res.courses;
      if (!state.courseStart) setPoint('course', start, startLabel, { noRoute: true });
      renderCourseCards();
      selectCourse(0);
      toast(`${res.courses.length}개의 그늘 산책 코스를 찾았어요 🍃`);
    } catch (e) {
      if (e && e.user) toast(e.user);
      else { console.error(e); toast('코스 계산 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.'); }
    } finally {
      busy(false);
    }
  }

  function renderCourseCards() {
    const wrap = $('course-cards');
    wrap.innerHTML = '';
    state.courses.forEach((c, i) => {
      const card = document.createElement('div');
      card.className = 'course-card';
      const covTxt = c.covLen > 20 ? ` · 지하·실내 ${U.fmtDist(c.covLen)}` : '';
      card.innerHTML = `
        <h3><span class="badge">코스 ${String.fromCharCode(65 + i)}</span> 그늘 <b style="color:var(--accent-dark)">${Math.round(c.shadeFrac * 100)}%</b></h3>
        <div class="course-meta">${U.fmtDist(c.totalLen)} · 약 ${U.fmtDur(c.timeS)} · ${U.fmtTime(c.depart)} 출발 기준${covTxt}</div>
        <div class="strip" id="course-strip-${i}"></div>`;
      card.addEventListener('click', () => selectCourse(i));
      wrap.appendChild(card);
      renderStrip('course-strip-' + i, c.pieces, c.totalLen);
    });
  }

  function selectCourse(i) {
    state.selCourse = i;
    document.querySelectorAll('.course-card').forEach((c, k) => c.classList.toggle('sel', k === i));
    const c = state.courses[i];
    setSrc('route', piecesToFC(c.pieces));
    setSrc('alt', emptyFC());
    setSrc('conn', emptyFC());
    state.routeOpts = null;
    $('route-result').classList.add('hidden');
    fitTo(c.pieces);
  }

  // ───────────────────────── 시간 바 ─────────────────────────
  const redrawShadowDebounced = U.debounce(() => { redrawShadow(); }, 130);
  const rerouteDebounced = U.debounce(() => { if (state.routeOpts && state.from && state.to) doRoute(); }, 900);

  $('rng-time').addEventListener('input', () => {
    if (state.playing) stopPlay();
    state.timeOffsetMin = parseInt($('rng-time').value, 10);
    updateTimeLabel();
    redrawShadowDebounced();
    rerouteDebounced();
  });
  $('btn-now').addEventListener('click', () => {
    stopPlay();
    $('rng-time').value = 0;
    state.timeOffsetMin = 0;
    updateTimeLabel();
    redrawShadow();
    rerouteDebounced();
  });

  // 하루 그림자 흐름 재생 — 그늘이 어떻게 이동하는지 눈으로 본다
  let playTimer = null;
  function stopPlay() {
    state.playing = false;
    clearInterval(playTimer);
    playTimer = null;
    $('btn-play').textContent = '▶';
    $('btn-play').classList.remove('on');
  }
  $('btn-play').addEventListener('click', () => {
    if (state.playing) { stopPlay(); return; }
    state.playing = true;
    $('btn-play').textContent = '⏸';
    $('btn-play').classList.add('on');
    playTimer = setInterval(() => {
      let v = state.timeOffsetMin + 10;
      if (v > 720) v = 0;
      state.timeOffsetMin = v;
      $('rng-time').value = String(v);
      updateTimeLabel();
      redrawShadow();
    }, 180);
  });

  function updateTimeLabel() {
    const d = currentDate();
    const today = new Date();
    const dayTxt = d.getDate() === today.getDate() ? '오늘' : '내일';
    let sunTxt = '';
    try {
      const c = map.getCenter();
      const tms = SW.sun.times(d, c.lat, c.lng);
      const pos = SW.sun.pos(d, c.lat, c.lng);
      if (pos.altDeg <= 0) sunTxt = ' · 🌙 밤';
      else if (tms.sunset) sunTxt = ` · 일몰 ${U.fmtTime(tms.sunset)}`;
    } catch (e) { /* ignore */ }
    $('lbl-time').textContent = `${dayTxt} ${U.fmtTime(d)}${sunTxt}`;
    $('btn-now').classList.toggle('on', state.timeOffsetMin === 0);
  }
  setInterval(updateTimeLabel, 60000);

  // ───────────────────────── 설정/탭/기타 UI ─────────────────────────
  $('btn-settings').addEventListener('click', () =>
    $('settings-pop').classList.toggle('hidden'));

  $('sel-h').addEventListener('change', async () => {
    state.defaultH = parseFloat($('sel-h').value);
    if (!state.data) return;
    busy(true, '건물 높이 다시 적용 중…');
    await tick();
    SW.osm.applyDefaultHeight(state.data, state.defaultH);
    SW.shadow.setData(state.data);
    SW.graph.build(state.data);
    redrawShadow();
    busy(false);
    rerouteDebounced();
  });
  $('sel-speed').addEventListener('change', () => {
    state.speedKmh = parseFloat($('sel-speed').value);
    rerouteDebounced();
  });
  $('chk-shadow').addEventListener('change', () => {
    state.showShadow = $('chk-shadow').checked;
    redrawShadow();
  });

  $('tab-route-btn').addEventListener('click', () => switchTab('route'));
  $('tab-course-btn').addEventListener('click', () => switchTab('course'));
  function switchTab(t) {
    $('tab-route-btn').classList.toggle('active', t === 'route');
    $('tab-course-btn').classList.toggle('active', t === 'course');
    $('tab-route').classList.toggle('hidden', t !== 'route');
    $('tab-course').classList.toggle('hidden', t !== 'course');
  }

  $('btn-panel-toggle').addEventListener('click', () => {
    const p = $('panel');
    p.classList.toggle('collapsed');
    $('btn-panel-toggle').textContent = p.classList.contains('collapsed') ? '›' : '‹';
  });

  // ───────────────────────── 토스트/로딩 ─────────────────────────
  let toastTimer = null;
  function toast(msg, ms) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), ms || 3800);
  }
  function busy(on, msg) {
    state.busy = on;
    $('busy').classList.toggle('hidden', !on);
    if (msg) busyMsg(msg);
    $('btn-route').disabled = on;
    $('btn-course').disabled = on;
  }
  function busyMsg(msg) { $('busy-msg').textContent = msg; }

  SW.app = { map, toast, doRoute, doCourses, currentDate };
})();
