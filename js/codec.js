/* codec.js — 미리 구운 지역 데이터의 압축 인코딩
 *
 * 좌표를 JSON 숫자 배열로 두면 한 점에 15~20바이트가 들지만,
 * 정수로 양자화해 직전 점과의 차이만 문자로 적으면 2~4바이트로 줄어든다.
 * (구글 encoded polyline과 같은 방식, 정밀도 1e5 ≒ 1.1m — 건물 그림자에는 충분)
 *
 * 브라우저(window.SW.codec)와 Node(require) 양쪽에서 그대로 쓴다.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.SW = root.SW || {}; root.SW.codec = api; }
})(typeof self !== 'undefined' ? self : this, function () {

  const P = 1e5; // 좌표 정밀도 (소수점 5자리 ≒ 1.1m)

  function encSigned(v, out) {
    let x = v < 0 ? ~(v << 1) : (v << 1);
    while (x >= 0x20) {
      out.push(String.fromCharCode((0x20 | (x & 0x1f)) + 63));
      x >>>= 5;
    }
    out.push(String.fromCharCode(x + 63));
  }

  /** [[lng,lat],...] → 문자열 */
  function encPath(pts) {
    const out = [];
    let px = 0, py = 0;
    for (const p of pts) {
      const x = Math.round(p[0] * P), y = Math.round(p[1] * P);
      encSigned(x - px, out);
      encSigned(y - py, out);
      px = x; py = y;
    }
    return out.join('');
  }

  /** 문자열 → [[lng,lat],...] */
  function decPath(s) {
    const pts = [];
    let i = 0, px = 0, py = 0;
    const n = s.length;
    while (i < n) {
      let shift = 0, res = 0, b;
      do { b = s.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      px += (res & 1) ? ~(res >> 1) : (res >> 1);
      shift = 0; res = 0;
      do { b = s.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      py += (res & 1) ? ~(res >> 1) : (res >> 1);
      pts.push([px / P, py / P]);
    }
    return pts;
  }

  /** 정수 배열 → 문자열 (직전 값과의 차이를 가변길이로) */
  function encInts(arr) {
    const out = [];
    let prev = 0;
    for (const v of arr) { encSigned(v - prev, out); prev = v; }
    return out.join('');
  }

  function decInts(s) {
    const arr = [];
    let i = 0, prev = 0;
    const n = s.length;
    while (i < n) {
      let shift = 0, res = 0, b;
      do { b = s.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      prev += (res & 1) ? ~(res >> 1) : (res >> 1);
      arr.push(prev);
    }
    return arr;
  }

  return { encPath, decPath, encInts, decInts, P };
});
