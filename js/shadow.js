/* shadow.js — 그림자 엔진: 건물/나무/숲의 그림자 폴리곤 생성 + 지점 그늘 판정
 *
 * 원리: 건물 외곽선의 각 변을 태양 반대 방향으로 (높이 × 1/tanθ) 만큼 밀어낸
 * 사각형들 + 밀린 외곽선 + 원래 외곽선의 합집합이 지면 그림자 영역.
 * 15분 단위 "슬라이스"로 캐싱해서 시간대별/도착시점 그늘 계산에 재사용.
 */
window.SW = window.SW || {};
SW.shadow = (function () {
  const U = SW.util;
  const SLICE_MS = 15 * 60 * 1000;

  let proj = null, origin = null;
  let bldM = [];    // {ring(m), bbox, h, tags}
  let treeM = [];   // [x,y]
  let canopyM = []; // 숲/수목 폴리곤 (m)
  let footGrid = null; // 건물 클릭 조회용
  const sets = new Map(); // sliceKey → shadow set

  function setData(data) {
    sets.clear();
    origin = [(data.bbox[1] + data.bbox[3]) / 2, (data.bbox[0] + data.bbox[2]) / 2];
    proj = U.makeProj(origin);
    bldM = data.buildings.map(b => {
      const ring = b.ring.map(proj.toM);
      return { ring, bbox: U.bboxOfRing(ring), h: b.h, tags: b.tags };
    });
    treeM = data.trees.map(proj.toM);
    canopyM = data.canopies.map(r => r.map(proj.toM));
    footGrid = new U.Grid(60);
    bldM.forEach((b, i) => footGrid.insertBBox(i, b.bbox));
  }

  function sliceKey(date) { return Math.floor(date.getTime() / SLICE_MS); }

  function getSet(date) {
    if (!proj) return null;
    const key = sliceKey(date);
    let s = sets.get(key);
    if (s) return s;
    s = build(new Date(key * SLICE_MS + SLICE_MS / 2));
    s.key = key;
    sets.set(key, s);
    if (sets.size > 30) sets.delete(sets.keys().next().value); // 오래된 것부터 정리
    return s;
  }

  function ccw(ring) { return U.ringArea(ring) > 0 ? ring : ring.slice().reverse(); }

  function build(date) {
    const su = SW.sun.shadowUnit(date, origin[1], origin[0]);
    if (su.night) return { night: true, full: true, altDeg: su.altDeg };
    if (su.full) return { night: false, full: true, altDeg: su.altDeg };

    const polys = [], grid = new U.Grid(48);
    const push = (ring) => {
      const r = ccw(ring);
      grid.insertBBox(polys.length, U.bboxOfRing(r));
      polys.push(r);
    };

    for (const b of bldM) {
      let dx = su.ux * b.h, dy = su.uy * b.h;
      const L = Math.hypot(dx, dy);
      if (L > 320) { dx *= 320 / L; dy *= 320 / L; }
      const ring = b.ring, n = ring.length;
      push(ring);                                    // 건물 바닥 (아래 통로 = 그늘)
      push(ring.map(p => [p[0] + dx, p[1] + dy]));   // 밀려난 외곽선
      for (let i = 0; i < n; i++) {                  // 각 변의 스윕 사각형
        const p = ring[i], q = ring[(i + 1) % n];
        push([[p[0], p[1]], [q[0], q[1]], [q[0] + dx, q[1] + dy], [p[0] + dx, p[1] + dy]]);
      }
    }
    for (const c of canopyM) push(c); // 숲: 캐노피 자체를 그늘로
    for (const t of treeM) {          // 가로수: 작은 8각형 그늘
      const cx = t[0] + su.ux * 4, cy = t[1] + su.uy * 4, r = 5, ring = [];
      for (let a = 0; a < 8; a++) ring.push([cx + r * Math.cos(a * Math.PI / 4), cy + r * Math.sin(a * Math.PI / 4)]);
      push(ring);
    }
    return { night: false, full: false, altDeg: su.altDeg, polys, grid };
  }

  function isShadedM(x, y, set) {
    if (!set) return false;
    if (set.full) return true;
    const cand = set.grid.queryCell(x, y);
    for (const i of cand) {
      if (U.pointInRing(x, y, set.polys[i])) return true;
    }
    return false;
  }

  function isShadedLL(ll, set) {
    const m = proj.toM(ll);
    return isShadedM(m[0], m[1], set);
  }

  function buildingAt(ll) {
    if (!footGrid) return null;
    const m = proj.toM(ll);
    const cand = footGrid.queryCell(m[0], m[1]);
    for (const i of cand) {
      const b = bldM[i];
      if (U.pointInRing(m[0], m[1], b.ring)) return b;
    }
    return null;
  }

  // 화면에 그릴 폴리곤 인덱스 (뷰포트 bbox, m 좌표)
  function viewPolys(set, bboxM) {
    if (!set || set.full) return null;
    return { polys: set.polys, idx: set.grid.queryBBox(bboxM) };
  }

  return {
    setData, getSet, isShadedM, isShadedLL, buildingAt, viewPolys, SLICE_MS,
    get proj() { return proj; },
    get origin() { return origin; },
    get buildingCount() { return bldM.length; },
    get treeCount() { return treeM.length; },
  };
})();
