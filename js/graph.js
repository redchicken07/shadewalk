/* graph.js — OSM 보행로 → 그래프 구축 + 시간 인지 그늘 가중 A* 라우팅
 *
 * 비용 = 걷는시간 × 도로등급계수 × (1 + α × 햇빛노출비율)
 * 햇빛노출비율은 "그 구간을 실제로 지나는 시각"의 그림자 슬라이스로 평가 →
 * 도착 시점의 그늘 변화까지 반영된다. 지하도/실내(covered)는 항상 그늘.
 */
window.SW = window.SW || {};
SW.graph = (function () {
  const U = SW.util;
  let g = null; // {nodes, adj, edges, grid, comp, bigComp, fracCache}

  function build(data) {
    const proj = SW.shadow.proj;

    // 두 개 이상의 길이 공유하는 노드(교차점)와 각 길의 양끝 → 그래프 정점
    const usage = new Map();
    for (const w of data.ways) {
      const n = w.nodes;
      for (let i = 0; i < n.length; i++) {
        usage.set(n[i], (usage.get(n[i]) || 0) + ((i === 0 || i === n.length - 1) ? 2 : 1));
      }
    }

    const nodeIdx = new Map(), nodes = [], edges = [];
    function vId(nid, ll) {
      let v = nodeIdx.get(nid);
      if (v === undefined) {
        v = nodes.length;
        nodeIdx.set(nid, v);
        nodes.push({ ll, m: proj.toM(ll) });
      }
      return v;
    }

    for (const w of data.ways) {
      const n = w.nodes, gm = w.geom;
      if (!n || n.length !== gm.length) continue;
      let lastV = vId(n[0], gm[0]);
      let segLL = [gm[0]];
      for (let i = 1; i < n.length; i++) {
        segLL.push(gm[i]);
        if (usage.get(n[i]) >= 2 || i === n.length - 1) {
          const v = vId(n[i], gm[i]);
          const geomLL = segLL;
          const geomM = geomLL.map(proj.toM);
          const cum = U.cumDist(geomM);
          const len = cum[cum.length - 1];
          if (len > 0.1 && v !== lastV) {
            edges.push({
              a: lastV, b: v, geomLL, geomM, cum, len,
              covered: w.covered, steps: w.steps, roadMult: w.roadMult,
              name: (w.tags && w.tags.name) || '',
            });
          }
          lastV = v;
          segLL = [gm[i]];
        }
      }
    }

    const adj = nodes.map(() => []);
    edges.forEach((e, i) => { adj[e.a].push(i); adj[e.b].push(i); });

    // 연결요소 (가장 큰 성분에서만 스냅 → 고립된 골목으로 스냅되는 실패 방지)
    const parent = new Int32Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) parent[i] = i;
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    for (const e of edges) { const ra = find(e.a), rb = find(e.b); if (ra !== rb) parent[ra] = rb; }
    const compSize = new Map();
    for (let i = 0; i < nodes.length; i++) { const r = find(i); compSize.set(r, (compSize.get(r) || 0) + 1); }
    let bigComp = -1, bs = 0;
    for (const [r, s] of compSize) if (s > bs) { bs = s; bigComp = r; }

    const grid = new U.Grid(90);
    nodes.forEach((nd, i) => { if (find(i) === bigComp) grid.insertPoint(i, nd.m[0], nd.m[1]); });

    g = { nodes, adj, edges, grid, fracCache: new Map() };
    return g;
  }

  function snap(ll) { // 가장 가까운 (큰 성분의) 정점 찾기
    if (!g || !g.nodes.length) return null;
    const m = SW.shadow.proj.toM(ll);
    for (let r = 0; r <= 5; r++) {
      const cand = g.grid.queryRing(m[0], m[1], r);
      if (!cand.length) continue;
      const extra = g.grid.queryRing(m[0], m[1], r + 1); // 셀 경계 보정
      let best = -1, bd = Infinity;
      for (const i of cand.concat(extra)) {
        const d = U.dist2(m, g.nodes[i].m);
        if (d < bd) { bd = d; best = i; }
      }
      const dist = Math.sqrt(bd);
      return dist <= 400 ? { v: best, ll: g.nodes[best].ll, distM: dist } : null;
    }
    return null;
  }

  // 구간의 햇빛 노출 비율 (0=전부 그늘, 1=전부 햇빛). 12m 간격 샘플링 + 캐시.
  function edgeFrac(eIdx, set) {
    const e = g.edges[eIdx];
    if (e.covered || set.full) return 0;
    const ck = eIdx + '|' + set.key;
    let v = g.fracCache.get(ck);
    if (v !== undefined) return v;
    let pts = e.samples;
    if (!pts) {
      const n = Math.max(2, Math.ceil(e.len / 12) + 1);
      pts = [];
      for (let i = 0; i < n; i++) pts.push(U.pointAt(e.geomM, e.cum, e.len * i / (n - 1)));
      e.samples = pts;
    }
    let sun = 0;
    for (const p of pts) if (!SW.shadow.isShadedM(p[0], p[1], set)) sun++;
    v = sun / pts.length;
    g.fracCache.set(ck, v);
    return v;
  }

  function heapPush(hp, it) {
    hp.push(it);
    let i = hp.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hp[p][0] <= hp[i][0]) break;
      const t = hp[p]; hp[p] = hp[i]; hp[i] = t;
      i = p;
    }
  }
  function heapPop(hp) {
    const top = hp[0], last = hp.pop();
    if (hp.length) {
      hp[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let s = i;
        if (l < hp.length && hp[l][0] < hp[s][0]) s = l;
        if (r < hp.length && hp[r][0] < hp[s][0]) s = r;
        if (s === i) break;
        const t = hp[s]; hp[s] = hp[i]; hp[i] = t;
        i = s;
      }
    }
    return top;
  }

  /** opts.coverPref > 0 이면 지하도·실내 구간의 비용을 깎아 우선 이용한다 */
  function route(sV, tV, depart, alpha, speed, opts) {
    if (!g || sV === tV) return null;
    const coverPref = (opts && opts.coverPref) || 0;
    const coverMul = 1 / (1 + coverPref);
    const N = g.nodes.length;
    const gW = new Float64Array(N).fill(Infinity); // 가중 비용 (탐색 기준)
    const gT = new Float64Array(N).fill(Infinity); // 순수 도보 시간 (슬라이스 평가용)
    const fromE = new Int32Array(N).fill(-1);
    const fromN = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const tm = g.nodes[tV].m;
    // 지하도 할인 때문에 구간 비용이 도보시간보다 싸질 수 있어, 휴리스틱도 같은 비율로 낮춰
    // 과대추정(= 최적 경로를 놓치는 경우)을 막는다.
    const hScale = Math.min(1, coverMul) / speed;
    const h = (i) => U.distM(g.nodes[i].m, tm) * hScale;
    const departMs = depart.getTime();

    gW[sV] = 0; gT[sV] = 0;
    const heap = [[h(sV), sV]];
    let found = false, guard = 0;

    while (heap.length) {
      const [, u] = heapPop(heap);
      if (closed[u]) continue;
      closed[u] = 1;
      if (u === tV) { found = true; break; }
      if (++guard > 300000) break;

      const set = SW.shadow.getSet(new Date(departMs + gT[u] * 1000));
      for (const ei of g.adj[u]) {
        const e = g.edges[ei];
        const v = e.a === u ? e.b : e.a;
        if (closed[v]) continue;
        const wt = (e.len / speed) * (e.steps ? 1.6 : 1);
        const frac = edgeFrac(ei, set);
        let cost = wt * e.roadMult * (1 + alpha * frac);
        if (e.covered) cost *= coverMul;
        const nw = gW[u] + cost;
        if (nw < gW[v] - 1e-9) {
          gW[v] = nw; gT[v] = gT[u] + wt;
          fromE[v] = ei; fromN[v] = u;
          heapPush(heap, [nw + h(v), v]);
        }
      }
    }
    if (!found) return null;

    const seq = [];
    let cur = tV;
    while (cur !== sV) { seq.push({ e: fromE[cur], from: fromN[cur] }); cur = fromN[cur]; }
    seq.reverse();
    return assemble(seq, depart, speed);
  }

  // 경로를 "지나는 시각 기준" 그늘/햇빛/지하 조각으로 분해 + 통계
  function assemble(seq, depart, speed) {
    const proj = SW.shadow.proj;
    const pieces = [];
    let t = 0, totalLen = 0, sunLen = 0, covLen = 0;
    const departMs = depart.getTime();

    for (const s of seq) {
      const e = g.edges[s.e];
      const rev = (s.from === e.b);
      const L = e.len;
      const set = SW.shadow.getSet(new Date(departMs + t * 1000));

      if (e.covered || set.full) {
        pieces.push({ state: e.covered ? 'covered' : 'shade', ll: rev ? e.geomLL.slice().reverse() : e.geomLL.slice(), len: L });
        if (e.covered) covLen += L;
      } else {
        const gM = rev ? e.geomM.slice().reverse() : e.geomM;
        const gLL = rev ? e.geomLL.slice().reverse() : e.geomLL;
        const cums = U.cumDist(gM);
        const n = Math.max(2, Math.ceil(L / 12) + 1);
        const states = [];
        for (let i = 0; i < n; i++) {
          const p = U.pointAt(gM, cums, L * i / (n - 1));
          states.push(SW.shadow.isShadedM(p[0], p[1], set));
        }
        let start = 0;
        for (let i = 1; i <= n; i++) {
          if (i === n || states[i] !== states[start]) {
            const d0 = start === 0 ? 0 : L * (start - 0.5) / (n - 1);
            const d1 = i === n ? L : L * (i - 0.5) / (n - 1);
            const mpts = U.slicePolyline(gM, cums, d0, d1);
            const segL = d1 - d0;
            pieces.push({ state: states[start] ? 'shade' : 'sun', ll: mpts.map(proj.toLL), len: segL });
            if (!states[start]) sunLen += segL;
            start = i;
          }
        }
      }
      totalLen += L;
      t += (L / speed) * (e.steps ? 1.6 : 1);
    }

    const shadeLen = totalLen - sunLen;
    return {
      pieces, totalLen, timeS: t, sunLen, shadeLen, covLen,
      shadeFrac: totalLen > 0 ? shadeLen / totalLen : 1,
      depart, arrive: new Date(departMs + t * 1000),
      edgeIdxs: seq.map(s => s.e),
    };
  }

  return {
    build, snap, route,
    edge: (i) => g.edges[i],
    counts: () => (g ? { nodes: g.nodes.length, edges: g.edges.length } : { nodes: 0, edges: 0 }),
    has: () => !!g,
  };
})();
