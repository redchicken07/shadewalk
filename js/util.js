/* util.js — 공용 지오메트리/도우미 함수 (그늘길) */
window.SW = window.SW || {};
SW.util = (function () {
  const R = 6371000, D2R = Math.PI / 180;

  // [lng,lat] 두 점 사이 거리 (m)
  function haversine(a, b) {
    const dLat = (b[1] - a[1]) * D2R, dLng = (b[0] - a[0]) * D2R;
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(a[1] * D2R) * Math.cos(b[1] * D2R) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  // 로컬 평면(m) 투영 — 도시 스케일에서 충분한 정확도
  function makeProj(origin) { // origin [lng,lat]
    const mLat = 111132, mLng = 111320 * Math.cos(origin[1] * D2R);
    return {
      origin,
      toM: (ll) => [(ll[0] - origin[0]) * mLng, (ll[1] - origin[1]) * mLat],
      toLL: (m) => [origin[0] + m[0] / mLng, origin[1] + m[1] / mLat],
      mLat, mLng,
    };
  }

  function dist2(a, b) { const dx = a[0] - b[0], dy = a[1] - b[1]; return dx * dx + dy * dy; }
  function distM(a, b) { return Math.sqrt(dist2(a, b)); }

  // ray casting — ring은 닫는 중복점 없는 [[x,y],...]
  function pointInRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  function ringArea(ring) { // CCW 양수
    let s = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    }
    return s / 2;
  }

  function bboxOfRing(ring) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of ring) {
      if (p[0] < x0) x0 = p[0]; if (p[1] < y0) y0 = p[1];
      if (p[0] > x1) x1 = p[0]; if (p[1] > y1) y1 = p[1];
    }
    return [x0, y0, x1, y1];
  }

  // 균일 격자 공간 인덱스
  class Grid {
    constructor(cell) { this.cell = cell; this.m = new Map(); }
    _k(cx, cy) { return cx + ':' + cy; }
    insertBBox(idx, b) {
      const c = this.cell;
      for (let cy = Math.floor(b[1] / c); cy <= Math.floor(b[3] / c); cy++)
        for (let cx = Math.floor(b[0] / c); cx <= Math.floor(b[2] / c); cx++) {
          const k = this._k(cx, cy);
          let a = this.m.get(k); if (!a) { a = []; this.m.set(k, a); }
          a.push(idx);
        }
    }
    insertPoint(idx, x, y) {
      const c = this.cell, k = this._k(Math.floor(x / c), Math.floor(y / c));
      let a = this.m.get(k); if (!a) { a = []; this.m.set(k, a); }
      a.push(idx);
    }
    queryCell(x, y) {
      return this.m.get(this._k(Math.floor(x / this.cell), Math.floor(y / this.cell))) || [];
    }
    queryBBox(b, out) {
      out = out || new Set();
      const c = this.cell;
      for (let cy = Math.floor(b[1] / c); cy <= Math.floor(b[3] / c); cy++)
        for (let cx = Math.floor(b[0] / c); cx <= Math.floor(b[2] / c); cx++) {
          const a = this.m.get(this._k(cx, cy));
          if (a) for (const i of a) out.add(i);
        }
      return out;
    }
    queryRing(x, y, ring) { // 체비쇼프 거리 ring 셀들만
      const c = this.cell, cx0 = Math.floor(x / c), cy0 = Math.floor(y / c), out = [];
      if (ring === 0) {
        const a = this.m.get(this._k(cx0, cy0));
        if (a) out.push(...a);
        return out;
      }
      for (let dx = -ring; dx <= ring; dx++)
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const a = this.m.get(this._k(cx0 + dx, cy0 + dy));
          if (a) out.push(...a);
        }
      return out;
    }
  }

  function cumDist(pts) { // m 좌표 폴리라인의 누적거리
    const c = [0];
    for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + distM(pts[i - 1], pts[i]));
    return c;
  }

  function pointAt(pts, cum, d) { // 거리 d 지점 보간
    if (d <= 0) return pts[0].slice();
    const L = cum[cum.length - 1];
    if (d >= L) return pts[pts.length - 1].slice();
    let i = 1;
    while (cum[i] < d) i++;
    const t = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t,
            pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
  }

  function slicePolyline(pts, cum, d0, d1) { // [d0,d1] 구간 추출
    const out = [pointAt(pts, cum, d0)];
    for (let i = 0; i < pts.length; i++) {
      if (cum[i] > d0 && cum[i] < d1) out.push(pts[i].slice());
    }
    out.push(pointAt(pts, cum, d1));
    return out;
  }

  function fmtDist(m) { return m < 950 ? Math.round(m) + 'm' : (m / 1000).toFixed(m < 9500 ? 1 : 0) + 'km'; }
  function fmtDur(s) {
    const m = Math.round(s / 60);
    if (m < 60) return m + '분';
    return Math.floor(m / 60) + '시간 ' + (m % 60) + '분';
  }
  function fmtTime(d) {
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function debounce(fn, ms) {
    let t = null;
    return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); };
  }
  function el(id) { return document.getElementById(id); }

  // 긴 계산 중간에 화면이 멈추지 않도록 제어권을 넘긴다.
  // setTimeout(0)은 브라우저가 백그라운드 탭에서 분당 1회까지 늦추기 때문에
  // (탭을 옮기면 계산이 사실상 정지) 스로틀링되지 않는 MessageChannel을 쓴다.
  const yieldToUI = (function () {
    if (typeof MessageChannel !== 'function') {
      return () => new Promise(r => setTimeout(r, 0));
    }
    const ch = new MessageChannel();
    const queue = [];
    ch.port1.onmessage = () => { const fn = queue.shift(); if (fn) fn(); };
    return () => new Promise(r => { queue.push(r); ch.port2.postMessage(0); });
  })();

  return {
    haversine, makeProj, dist2, distM, pointInRing, ringArea, bboxOfRing, Grid,
    cumDist, pointAt, slicePolyline, fmtDist, fmtDur, fmtTime, debounce, el, yieldToUI,
  };
})();
