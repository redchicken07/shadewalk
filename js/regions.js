/* regions.js — 미리 구워 둔 지역 데이터를 불러온다.
 *
 * 앱은 실행 중 Overpass·Nominatim 같은 공용 서버를 부르지 않는다.
 * data/ 안의 정적 파일만 읽으므로 호출 제한도, 비용도, 이용약관 문제도 없다.
 * (데이터를 굽는 쪽은 tools/prebake.js — 개발자가 가끔 손으로 돌린다)
 */
window.SW = window.SW || {};
SW.regions = (function () {
  const C = SW.codec;
  const BASE = 'data/';

  let index = null;              // [{id,city,name,sub,c,r,bbox,kb,...}]
  const cache = new Map();       // id → 디코드된 데이터
  const inflight = new Map();    // id → Promise (같은 지역 중복 요청 방지)

  async function loadIndex() {
    if (index) return index;
    const r = await fetch(BASE + 'index.json');
    if (!r.ok) throw new Error('지역 목록을 불러오지 못했어요 (index.json ' + r.status + ')');
    const j = await r.json();
    index = j.regions || [];
    return index;
  }

  function list() { return index || []; }
  function get(id) { return (index || []).find(r => r.id === id) || null; }

  const kmBetween = (a, b) =>
    Math.hypot((b[1] - a[1]) * 111, (b[0] - a[0]) * 111 * Math.cos(a[1] * Math.PI / 180));

  /** 점을 품고 있는 지역 (가장 중심에 가까운 것 우선) */
  function containing(ll) {
    let best = null, bd = Infinity;
    for (const r of (index || [])) {
      const b = r.bbox;
      if (ll[1] < b[0] || ll[1] > b[2] || ll[0] < b[1] || ll[0] > b[3]) continue;
      const d = kmBetween(ll, r.c);
      if (d < bd) { bd = d; best = r; }
    }
    return best;
  }

  /** 가장 가까운 지역 + 거리(km) */
  function nearest(ll) {
    let best = null, bd = Infinity;
    for (const r of (index || [])) {
      const d = kmBetween(ll, r.c);
      if (d < bd) { bd = d; best = r; }
    }
    return best ? { region: best, km: bd } : null;
  }

  /** 도시별로 묶은 목록 (선택 UI용) */
  function byCity() {
    const m = new Map();
    for (const r of (index || [])) {
      if (!m.has(r.city)) m.set(r.city, []);
      m.get(r.city).push(r);
    }
    return [...m.entries()];
  }

  // ───────── 디코딩 ─────────

  // 굽는 쪽에서 높이를 미리 계산했지만, 사용자가 "기본 건물 높이"를 바꿀 수 있어야 하므로
  // 원래 태그를 되살려 둔다. 그래야 osm.js의 parseHeight가 그대로 동작한다.
  function tagsForBuilding(h, src, name) {
    const t = {};
    if (name) t.name = name;
    if (src & 2) t.height = String(h);
    else if (src & 1) t['building:levels'] = String(Math.round((h - 1.2) / 3.2));
    else if (src & 4) t.building = 'roof';
    return t;
  }

  function decode(raw) {
    const bld = raw.bld, way = raw.way;

    const bh = C.decInts(bld.h), bs = C.decInts(bld.s), bni = C.decInts(bld.ni);
    const bNameAt = new Map();
    bni.forEach((gi, k) => bNameAt.set(gi, bld.nm[k]));

    const buildings = bld.g.map((s, i) => {
      const h = bh[i] / 2, src = bs[i];
      return { ring: C.decPath(s), h, tags: tagsForBuilding(h, src, bNameAt.get(i)) };
    });

    const wf = C.decInts(way.f), wm = C.decInts(way.m), wni = C.decInts(way.ni);
    const wNameAt = new Map();
    wni.forEach((gi, k) => wNameAt.set(gi, way.nm[k]));

    const ways = way.g.map((s, i) => {
      const name = wNameAt.get(i);
      return {
        id: i,
        geom: C.decPath(s),
        nodes: C.decInts(way.n[i]),
        tags: name ? { name } : {},
        covered: !!(wf[i] & 1),
        steps: !!(wf[i] & 2),
        roadMult: wm[i] / 100,
      };
    });

    const pk = C.decInts(raw.poi.k);
    const pois = C.decPath(raw.poi.g).map((ll, i) => ({
      name: raw.poi.n[i], kind: raw.poi.kinds[pk[i]] || '', ll,
    }));

    return {
      regionId: raw.id, regionName: raw.name, bbox: raw.bbox,
      buildings, ways,
      trees: raw.tree ? C.decPath(raw.tree) : [],
      canopies: (raw.canopy || []).map(C.decPath),
      pois,
      ts: Date.now(),
    };
  }

  /** 지역 데이터 불러오기 (한 번 받으면 메모리에 남는다) */
  function load(id, onStatus) {
    if (cache.has(id)) return Promise.resolve(cache.get(id));
    if (inflight.has(id)) return inflight.get(id);

    const p = (async () => {
      if (onStatus) onStatus('지역 데이터 불러오는 중…');
      const r = await fetch(BASE + id + '.json');
      if (!r.ok) throw new Error('지역 데이터를 불러오지 못했어요 (' + id + ' ' + r.status + ')');
      const raw = await r.json();
      if (onStatus) onStatus('건물·보행로 준비 중…');
      await SW.util.yieldToUI();
      const data = decode(raw);
      cache.set(id, data);
      inflight.delete(id);
      return data;
    })();
    inflight.set(id, p);
    p.catch(() => inflight.delete(id));
    return p;
  }

  return { loadIndex, list, get, containing, nearest, byCity, load };
})();
