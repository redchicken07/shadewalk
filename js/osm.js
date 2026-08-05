/* osm.js — OSM 태그 해석 규칙
 *
 * 예전에는 앱이 실행 중 Overpass를 직접 불렀지만, 공용 서버는 일반 사용자용 앱의
 * 백엔드로 쓰는 것을 정책으로 금지한다(하루 1만 요청·1GB 권고). 지금은 tools/prebake.js가
 * 데이터를 미리 받아 data/ 아래에 구워 두고, 앱은 그 정적 파일만 읽는다.
 * 여기에는 그때도 지금도 똑같이 필요한 "태그 → 값" 규칙만 남는다.
 */
window.SW = window.SW || {};
SW.osm = (function () {

  /** 건물 높이(m). 실측 > 층수 > 기본값 순. 지하 구조물은 0. */
  function parseHeight(tags, defH) {
    if (tags.height) {
      const v = parseFloat(String(tags.height).replace(/[^\d.\-]/g, ''));
      if (v > 1 && v < 400) return v;
    }
    if (tags['building:height']) {
      const v = parseFloat(tags['building:height']);
      if (v > 1 && v < 400) return v;
    }
    if (tags['building:levels']) {
      const l = parseFloat(tags['building:levels']);
      if (l > 0 && l < 120) return l * 3.2 + 1.2;
    }
    if (tags.layer && parseFloat(tags.layer) < 0) return 0;
    if (tags.building === 'roof') return defH * 0.6;
    return defH;
  }

  /** 설정에서 "기본 건물 높이"를 바꿨을 때 — 높이 정보가 없던 건물만 달라진다 */
  function applyDefaultHeight(data, defH) {
    for (const b of data.buildings) b.h = parseHeight(b.tags, defH);
  }

  return { parseHeight, applyDefaultHeight };
})();
