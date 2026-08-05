/* course.js — 그늘 산책 코스(순환 루프) 추천
 *
 * 시작점에서 8방위로 다이아몬드형 경유점을 만들어 루프를 라우팅하고,
 * "실제로 지나는 시각"의 그늘 비율 + 경로 중복도(왕복 회피)로 점수를 매겨
 * 상위 3개 코스를 고른다.
 */
window.SW = window.SW || {};
SW.course = (function () {
  const U = SW.util;

  function polarLL(centerLL, distM, bearingDeg) {
    const proj = SW.shadow.proj;
    const m = proj.toM(centerLL);
    const br = bearingDeg * Math.PI / 180;
    return proj.toLL([m[0] + Math.sin(br) * distM, m[1] + Math.cos(br) * distM]);
  }

  function concatRoutes(rs) {
    const pieces = [].concat(...rs.map(r => r.pieces));
    const totalLen = rs.reduce((s, r) => s + r.totalLen, 0);
    const timeS = rs.reduce((s, r) => s + r.timeS, 0);
    const sunLen = rs.reduce((s, r) => s + r.sunLen, 0);
    const covLen = rs.reduce((s, r) => s + r.covLen, 0);
    const edgeIdxs = [].concat(...rs.map(r => r.edgeIdxs));
    return {
      pieces, totalLen, timeS, sunLen, covLen,
      shadeLen: totalLen - sunLen,
      shadeFrac: totalLen > 0 ? (totalLen - sunLen) / totalLen : 1,
      depart: rs[0].depart,
      arrive: new Date(rs[0].depart.getTime() + timeS * 1000),
      edgeIdxs,
    };
  }

  async function recommend(startLL, minutes, depart, alpha, speed, onProg, coverPref) {
    const s0 = SW.graph.snap(startLL);
    if (!s0) return { err: 'noSnap' };
    coverPref = coverPref || 0;

    const targetL = speed * 60 * minutes; // 목표 코스 길이 (m)
    // 다이아몬드 4변의 직선 합은 반경의 약 3.95배, 여기에 실제 도로 우회(≒1.45배)를 감안한 계수.
    const r0 = targetL / 5.8;
    const out = [];

    /** 한 방위로 다이아몬드 루프를 한 번 돌려 본다 */
    function tryLoop(th, r) {
      const wps = [
        polarLL(s0.ll, r, th - 42),
        polarLL(s0.ll, r * 1.45, th),
        polarLL(s0.ll, r, th + 42),
      ];
      const snaps = wps.map(w => SW.graph.snap(w));
      if (snaps.some(x => !x)) return null;

      const vseq = [s0.v, ...snaps.map(s => s.v), s0.v];
      let t = depart, legs = [];
      for (let i = 0; i < vseq.length - 1; i++) {
        if (vseq[i] === vseq[i + 1]) continue;
        const leg = SW.graph.route(vseq[i], vseq[i + 1], t, alpha, speed, { coverPref });
        if (!leg) return null;
        legs.push(leg);
        t = new Date(t.getTime() + leg.timeS * 1000);
      }
      if (legs.length < 2) return null;

      const c = concatRoutes(legs);
      const uniq = new Set(c.edgeIdxs);
      let uniqLen = 0;
      for (const ei of uniq) uniqLen += SW.graph.edge(ei).len;
      c.uniqFrac = Math.min(1, uniqLen / c.totalLen);
      c.fit = Math.max(0, 1 - Math.abs(c.totalLen - targetL) / targetL);
      c.score = c.shadeFrac * 0.62 + c.uniqFrac * 0.16 + c.fit * 0.22;
      c.bearing = th;
      c.radius = r;
      c.inRange = c.totalLen >= targetL * 0.65 && c.totalLen <= targetL * 1.4;
      return c;
    }

    for (let bi = 0; bi < 8; bi++) {
      if (onProg) onProg(`코스 탐색 중… ${bi + 1}/8 방향`);
      await U.yieldToUI(); // 화면이 멈추지 않게 (백그라운드 탭에서도 지연되지 않음)

      const th = bi * 45;
      let c = tryLoop(th, r0);
      if (!c) continue;

      // 그늘을 좇다 보면 길이가 크게 부풀거나 줄어든다 (강남에서 5배까지 벌어졌다).
      // 목표에서 벗어났으면 반경을 실측 비율로 고쳐 한 번만 다시 시도한다.
      // 3배 넘게 빗나간 방향은 길이 막힌 쪽이라 고쳐도 안 되므로 그냥 버린다.
      if (!c.inRange) {
        const ratio = targetL / c.totalLen;
        if (ratio >= 0.33 && ratio <= 3) {
          await U.yieldToUI();
          const c2 = tryLoop(th, r0 * Math.max(0.3, Math.min(2.2, ratio)));
          if (c2 && Math.abs(c2.totalLen - targetL) < Math.abs(c.totalLen - targetL)) c = c2;
        }
      }
      out.push(c);
    }
    if (!out.length) return { courses: [], start: s0 };

    // 목표 길이에 맞는 코스 우선, 없으면 전체에서 고른다
    const pool = out.some(c => c.inRange) ? out.filter(c => c.inRange) : out;
    pool.sort((a, b) => b.score - a.score);

    const picked = [];
    for (const c of pool) {
      const okSep = picked.every(p => {
        let d = Math.abs(p.bearing - c.bearing) % 360;
        if (d > 180) d = 360 - d;
        return d >= 60;
      });
      if (okSep) picked.push(c);
      if (picked.length >= 3) break;
    }
    return { courses: picked, start: s0 };
  }

  return { recommend };
})();
