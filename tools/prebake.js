#!/usr/bin/env node
/* prebake.js — 지역 데이터를 Overpass에서 한 번만 받아 정적 파일로 굽는다.
 *
 *   node tools/prebake.js            # 전체 (이미 구운 건 건너뜀)
 *   node tools/prebake.js sel-gbd    # 특정 지역만
 *   node tools/prebake.js --force    # 이미 있어도 다시
 *
 * 결과물은 data/<id>.json + data/index.json.
 * 이걸 깃헙에 올리면 앱은 실행 중 Overpass를 한 번도 부르지 않는다.
 *
 * ⚠ 이 스크립트는 개발자가 가끔 손으로 돌리는 용도다. 공용 Overpass 서버를 배려해
 *   한 번에 하나씩, 요청 사이에 넉넉히 쉬면서 받는다. 절대 병렬로 돌리지 말 것.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const codec = require('../js/codec.js');
const { REGIONS, bboxOf } = require('./regions.js');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data');

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const UA = 'shadewalk-prebake/1.0 (hobby project; one-off static data bake)';
const GAP_MS = 6000; // 지역 사이 대기 — 공용 서버 배려

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ───────────────────────── Overpass ─────────────────────────

function query(b) {
  const bb = `(${b[0]},${b[1]},${b[2]},${b[3]})`;
  return `[out:json][timeout:180];(
way["building"]${bb};
way["highway"~"^(footway|path|pedestrian|steps|corridor|living_street|residential|service|unclassified|tertiary|tertiary_link|secondary|secondary_link|primary|primary_link|track|cycleway)$"]${bb};
node["natural"="tree"]${bb};
way["natural"="tree_row"]${bb};
way["natural"="wood"]${bb};
way["landuse"="forest"]${bb};
node["name"]["shop"]${bb};
node["name"]["amenity"]${bb};
node["name"]["tourism"]${bb};
node["name"]["office"]${bb};
node["name"]["leisure"]${bb};
node["name"]["railway"]${bb};
node["name"]["public_transport"]${bb};
);out geom;`;
}

// 인코딩 설정을 바꿔 가며 다시 구울 때 Overpass를 또 부르지 않도록 원본을 남겨 둔다.
// (.cache는 깃에 올리지 않는다 — .gitignore 참고)
const CACHE_DIR = path.join(ROOT, '.cache');

function cachePath(id) { return path.join(CACHE_DIR, id + '.raw.json'); }

async function overpassCached(reg, label, useCache) {
  const cp = cachePath(reg.id);
  if (useCache && fs.existsSync(cp)) {
    console.log(`    ${label} ← 캐시 사용 (${kb(fs.statSync(cp).size)})`);
    return JSON.parse(fs.readFileSync(cp, 'utf8'));
  }
  const j = await overpass(bboxOf(reg), label);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cp, JSON.stringify(j));
  return j;
}

async function overpass(b, label) {
  const body = 'data=' + encodeURIComponent(query(b));
  for (let round = 0; round < 4; round++) {
    for (const url of ENDPOINTS) {
      const host = new URL(url).host;
      process.stdout.write(`    ${label} ← ${host} … `);
      try {
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), 190000);
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
          body, signal: ctl.signal,
        });
        clearTimeout(to);
        if (!r.ok) { console.log(`HTTP ${r.status}`); await sleep(3000); continue; }
        const j = await r.json();
        const n = (j.elements || []).length;
        console.log(`${n.toLocaleString()} elements`);
        if (!n) { await sleep(3000); continue; }
        return j;
      } catch (e) {
        console.log('실패 (' + (e.message || e) + ')');
        await sleep(3000);
      }
    }
    const wait = 20 * (round + 1);
    console.log(`    …서버가 모두 바쁨. ${wait}초 후 재시도 (${round + 2}/4)`);
    await sleep(wait * 1000);
  }
  throw new Error('Overpass 응답 없음: ' + label);
}

// ───────────────────────── 파싱 (앱의 osm.js와 같은 규칙) ─────────────────────────

const HW_RE = /^(footway|path|pedestrian|steps|corridor|living_street|residential|service|unclassified|tertiary|tertiary_link|secondary|secondary_link|primary|primary_link|track|cycleway)$/;
const POI_KIND = ['shop', 'amenity', 'tourism', 'office', 'leisure', 'railway', 'public_transport'];

// 이름은 있지만 목적지로 검색될 일이 거의 없는 것들 — 용량만 차지한다.
// (강남 한 구역에만 미용실·네일샵이 2,200개 있었다)
const POI_SKIP = new Set([
  'hairdresser', 'beauty', 'nail_salon', 'tattoo', 'massage',
  'bicycle_rental', 'bicycle_parking', 'motorcycle_parking', 'vending_machine',
  'waste_basket', 'bench', 'atm', 'toilets', 'drinking_water', 'shelter',
  'charging_station', 'parking_space', 'smoking_area', 'clock', 'surveillance',
]);

// 높이를 "실측 / 층수 / 미상"으로 나눠 둔다. 미상은 앱에서 사용자가 고른 기본값을 쓴다.
function heightOf(tags) {
  const h = parseFloat(String(tags.height || tags['building:height'] || '').replace(/[^\d.\-]/g, ''));
  if (h > 1 && h < 400) return { h: Math.round(h * 2) / 2, src: 2 };
  const lv = parseFloat(tags['building:levels']);
  if (lv > 0 && lv < 120) return { h: Math.round((lv * 3.2 + 1.2) * 2) / 2, src: 1, lv };
  if (tags.layer && parseFloat(tags.layer) < 0) return null; // 지하 구조물
  return { h: 0, src: 0, roof: tags.building === 'roof' };    // 앱에서 기본높이 적용
}

function walkable(t) {
  if (!t.highway || !HW_RE.test(t.highway)) return false;
  if (t.foot === 'no' || t.foot === 'private') return false;
  if ((t.access === 'private' || t.access === 'no') && !(t.foot === 'yes' || t.foot === 'designated')) return false;
  if (t.area === 'yes') return false;
  return true;
}

function isCovered(t) {
  if (t.tunnel && t.tunnel !== 'no') return true;
  if (t.covered && t.covered !== 'no') return true;
  if (t.highway === 'corridor') return true;
  if (t.indoor && t.indoor !== 'no') return true;
  if (t.location === 'underground') return true;
  if (t.layer && parseFloat(t.layer) <= -1) return true;
  if (t.level && parseFloat(t.level) <= -1) return true;
  if (t.arcade && t.arcade !== 'no') return true;
  return false;
}

function roadMult(hw) {
  if (hw === 'primary' || hw === 'primary_link') return 125;
  if (hw === 'secondary' || hw === 'secondary_link') return 115;
  if (hw === 'tertiary' || hw === 'tertiary_link') return 105;
  return 100;
}

// ───────────────────────── 기하 단순화 ─────────────────────────

const D2R = Math.PI / 180;
function mPerDeg(lat) { return { x: 111320 * Math.cos(lat * D2R), y: 111132 }; }

function segDist2(p, a, b, s) { // 점-선분 거리² (m)
  const px = (p[0] - a[0]) * s.x, py = (p[1] - a[1]) * s.y;
  const bx = (b[0] - a[0]) * s.x, by = (b[1] - a[1]) * s.y;
  const L = bx * bx + by * by;
  let t = L > 0 ? (px * bx + py * by) / L : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - bx * t, dy = py - by * t;
  return dx * dx + dy * dy;
}

/** Douglas-Peucker — tolM(m) 이내로 벗어나지 않는 선에서 점을 줄인다 */
function simplify(pts, tolM, s) {
  if (pts.length < 3) return pts;
  const tol2 = tolM * tolM;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    let far = -1, fd = tol2;
    for (let i = i0 + 1; i < i1; i++) {
      const d = segDist2(pts[i], pts[i0], pts[i1], s);
      if (d > fd) { fd = d; far = i; }
    }
    if (far > 0) { keep[far] = 1; stack.push([i0, far], [far, i1]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function ringAreaM2(ring, s) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] * s.x) * (ring[i][1] * s.y) - (ring[i][0] * s.x) * (ring[j][1] * s.y);
  }
  return Math.abs(a / 2);
}

function closeRing(g) {
  let r = g;
  const a = r[0], b = r[r.length - 1];
  if (a[0] === b[0] && a[1] === b[1]) r = r.slice(0, -1);
  return r.length >= 3 ? r : null;
}

function centroid(g) {
  let x = 0, y = 0;
  for (const p of g) { x += p[0]; y += p[1]; }
  return [x / g.length, y / g.length];
}

// ───────────────────────── 굽기 ─────────────────────────

const MIN_BLD_M2 = 24;   // 이보다 작은 건물(창고·가판)은 그림자 기여가 없다
const BLD_TOL_M = 1.2;   // 건물 외곽선 단순화 허용 오차
const WAY_TOL_M = 1.5;   // 보행로 단순화 허용 오차

function bake(j, reg) {
  const bbox = bboxOf(reg);
  const s = mPerDeg(reg.c[1]);

  const bldGeom = [], bldH = [], bldSrc = [], bldName = [], bldNameIdx = [];
  const wayGeom = [], wayNodes = [], wayFlag = [], wayMult = [], wayName = [], wayNameIdx = [];
  const trees = [], canopies = [];
  const poiLL = [], poiName = [], poiKind = [];
  const kinds = [];
  const nodeMap = new Map(); // OSM node id → 0,1,2… (작은 정수라야 잘 압축된다)

  function nodeId(osmId) {
    let v = nodeMap.get(osmId);
    if (v === undefined) { v = nodeMap.size; nodeMap.set(osmId, v); }
    return v;
  }
  function kindId(k) {
    let i = kinds.indexOf(k);
    if (i < 0) { i = kinds.length; kinds.push(k); }
    return i;
  }
  function addPoi(tags, ll) {
    let kind = '';
    for (const k of POI_KIND) if (tags[k]) { kind = tags[k]; break; }
    if (POI_SKIP.has(kind)) return;
    if (tags.name.length > 40) return; // 설명문에 가까운 이름은 검색에 방해만 된다
    poiLL.push(ll); poiName.push(tags.name); poiKind.push(kindId(kind));
  }

  for (const el of (j.elements || [])) {
    const t = el.tags || {};
    if (el.type === 'node') {
      if (t.natural === 'tree') trees.push([el.lon, el.lat]);
      else if (t.name) addPoi(t, [el.lon, el.lat]);
      continue;
    }
    if (el.type !== 'way' || !el.geometry) continue;
    const geom = el.geometry.filter(Boolean).map(g => [g.lon, g.lat]);
    if (geom.length < 2) continue;

    if (t.building) {
      const ring = closeRing(geom);
      if (!ring) continue;
      if (t.name) addPoi(t, centroid(ring));
      const hi = heightOf(t);
      if (!hi) continue;
      if (ringAreaM2(ring, s) < MIN_BLD_M2) continue;
      const simp = simplify(ring, BLD_TOL_M, s);
      if (simp.length < 3) continue;
      bldGeom.push(simp);
      bldH.push(Math.round(hi.h * 2));   // 0.5m 단위 정수
      bldSrc.push(hi.src | (hi.roof ? 4 : 0));
      if (t.name) { bldNameIdx.push(bldGeom.length - 1); bldName.push(t.name); }
      continue;
    }

    if (t.name && POI_KIND.some(k => t[k])) addPoi(t, centroid(geom));

    if (t.natural === 'wood' || t.landuse === 'forest') {
      const ring = closeRing(geom);
      if (ring) canopies.push(simplify(ring, 4, s));
      continue;
    }
    if (t.natural === 'tree_row') { treeRow(geom, trees, s); continue; }

    if (walkable(t) && el.nodes && el.nodes.length === geom.length) {
      // 단순화하되 노드 id와 좌표의 짝은 반드시 유지해야 한다 (그래프 위상)
      const keepIdx = simplifyIdx(geom, WAY_TOL_M, s);
      wayGeom.push(keepIdx.map(i => geom[i]));
      wayNodes.push(keepIdx.map(i => nodeId(el.nodes[i])));
      wayFlag.push((isCovered(t) ? 1 : 0) | (t.highway === 'steps' ? 2 : 0));
      wayMult.push(roadMult(t.highway));
      if (t.name) { wayNameIdx.push(wayGeom.length - 1); wayName.push(t.name); }
    }
  }

  // POI 중복 제거
  const seen = new Set(), pLL = [], pN = [], pK = [];
  for (let i = 0; i < poiLL.length; i++) {
    const k = poiName[i] + '@' + poiLL[i][0].toFixed(4) + ',' + poiLL[i][1].toFixed(4);
    if (seen.has(k)) continue;
    seen.add(k);
    pLL.push(poiLL[i]); pN.push(poiName[i]); pK.push(poiKind[i]);
  }

  return {
    v: 1,
    id: reg.id, city: reg.city, name: reg.name, sub: reg.sub,
    c: reg.c, r: reg.r, bbox,
    bld: {
      g: bldGeom.map(codec.encPath),
      h: codec.encInts(bldH),
      s: codec.encInts(bldSrc),
      ni: codec.encInts(bldNameIdx),
      nm: bldName,
    },
    way: {
      g: wayGeom.map(codec.encPath),
      n: wayNodes.map(codec.encInts),
      f: codec.encInts(wayFlag),
      m: codec.encInts(wayMult),
      ni: codec.encInts(wayNameIdx),
      nm: wayName,
    },
    tree: codec.encPath(trees),
    canopy: canopies.map(codec.encPath),
    poi: { g: codec.encPath(pLL), n: pN, k: codec.encInts(pK), kinds },
  };
}

/** simplify와 같은 판정이지만 남긴 점의 "인덱스"를 준다 (노드 id와 짝 유지용) */
function simplifyIdx(pts, tolM, s) {
  if (pts.length < 3) return pts.map((_, i) => i);
  const tol2 = tolM * tolM;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    let far = -1, fd = tol2;
    for (let i = i0 + 1; i < i1; i++) {
      const d = segDist2(pts[i], pts[i0], pts[i1], s);
      if (d > fd) { fd = d; far = i; }
    }
    if (far > 0) { keep[far] = 1; stack.push([i0, far], [far, i1]); }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(i);
  return out;
}

function treeRow(geom, out, s) {
  out.push(geom[0]);
  for (let i = 1; i < geom.length; i++) {
    const dx = (geom[i][0] - geom[i - 1][0]) * s.x, dy = (geom[i][1] - geom[i - 1][1]) * s.y;
    const d = Math.hypot(dx, dy);
    if (d <= 0) continue;
    const n = Math.max(1, Math.round(d / 7));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push([geom[i - 1][0] + (geom[i][0] - geom[i - 1][0]) * t,
                geom[i - 1][1] + (geom[i][1] - geom[i - 1][1]) * t]);
    }
  }
}

// ───────────────────────── 실행 ─────────────────────────

const kb = (n) => (n / 1024).toFixed(0) + 'KB';

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  // --force 는 "OSM에서 새로 받아 다시 굽기"다. 인코딩만 바꿔 다시 구울 땐
  // --cached 를 붙여 받아 둔 원본을 재사용한다 (네트워크를 전혀 쓰지 않는다).
  const useCache = args.includes('--cached') || !force;
  const only = args.filter(a => !a.startsWith('--'));
  const list = only.length ? REGIONS.filter(r => only.includes(r.id)) : REGIONS;
  if (!list.length) {
    console.error('해당하는 지역이 없습니다. 사용 가능한 id:');
    console.error(REGIONS.map(r => '  ' + r.id).join('\n'));
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`\n🌳 그늘길 데이터 굽기 — 대상 ${list.length}개 지역\n`);

  const index = [];
  let totalBytes = 0, done = 0, failed = [];

  for (const reg of list) {
    const outPath = path.join(OUT_DIR, reg.id + '.json');
    const label = `[${reg.city}] ${reg.name}`;

    if (!force && fs.existsSync(outPath)) {
      const st = fs.statSync(outPath);
      console.log(`  ⏭  ${label} — 이미 있음 (${kb(st.size)}), 건너뜀`);
      index.push(indexEntry(reg, st.size, JSON.parse(fs.readFileSync(outPath, 'utf8'))));
      totalBytes += st.size;
      continue;
    }

    console.log(`  ▶  ${label} — ${reg.sub}`);
    let fromCache = false;
    try {
      fromCache = useCache && fs.existsSync(cachePath(reg.id));
      const j = await overpassCached(reg, label, useCache);
      const baked = bake(j, reg);
      const text = JSON.stringify(baked);
      fs.writeFileSync(outPath, text);
      const size = Buffer.byteLength(text);
      totalBytes += size;
      done++;
      console.log(`    ✔ 건물 ${baked.bld.g.length.toLocaleString()} · 보행로 ${baked.way.g.length.toLocaleString()}`
        + ` · 나무 ${(baked.tree.length ? codec.decPath(baked.tree).length : 0).toLocaleString()}`
        + ` · 장소 ${baked.poi.n.length.toLocaleString()} → ${kb(size)}\n`);
      index.push(indexEntry(reg, size, baked));
    } catch (e) {
      console.log(`    ✘ 실패: ${e.message}\n`);
      failed.push(reg.id);
    }
    if (!fromCache) await sleep(GAP_MS); // 캐시로 다시 구울 땐 기다릴 이유가 없다
  }

  index.sort((a, b) => a.city.localeCompare(b.city, 'ko') || a.name.localeCompare(b.name, 'ko'));
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'),
    JSON.stringify({ v: 1, built: new Date().toISOString().slice(0, 10), regions: index }, null, 1));

  console.log('─'.repeat(56));
  console.log(`완료: 새로 구움 ${done}개 · 전체 ${index.length}개 · 합계 ${kb(totalBytes)}`);
  if (failed.length) console.log(`실패: ${failed.join(', ')}  → node tools/prebake.js ${failed.join(' ')} 로 재시도`);
  console.log('─'.repeat(56) + '\n');
}

function indexEntry(reg, size, baked) {
  return {
    id: reg.id, city: reg.city, name: reg.name, sub: reg.sub,
    c: reg.c, r: reg.r, bbox: baked.bbox,
    kb: Math.round(size / 1024),
    bld: baked.bld.g.length, way: baked.way.g.length, poi: baked.poi.n.length,
  };
}

main().catch(e => { console.error(e); process.exit(1); });
