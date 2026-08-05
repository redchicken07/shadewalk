/* regions.js — 미리 구울 지역 목록 (사람이 많이 다니는 곳 위주)
 *
 * r: 중심에서의 반경(m). 실제 박스는 2r × 2r.
 *    도심 업무지구는 넓게, 대학가는 캠퍼스+상권이 들어갈 만큼만.
 * 이 파일은 굽는 도구와 앱이 함께 읽는다(앱은 data/index.json을 통해 간접적으로).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.SW = root.SW || {}; root.SW.regionDefs = api; }
})(typeof self !== 'undefined' ? self : this, function () {

  const REGIONS = [
    // ───────── 서울 3대 도심 + 주요 업무지구 ─────────
    { id: 'sel-cbd',    city: '서울', name: '도심 CBD',        sub: '시청·광화문·종로·을지로', c: [126.9820, 37.5685], r: 1700 },
    { id: 'sel-ybd',    city: '서울', name: '여의도 YBD',      sub: '여의도·IFC·국회',        c: [126.9265, 37.5250], r: 1500 },
    { id: 'sel-gbd',    city: '서울', name: '강남 GBD',        sub: '강남역·테헤란로·삼성',    c: [127.0390, 37.5015], r: 1800 },
    { id: 'sel-bbd',    city: '성남', name: '분당 BBD',        sub: '판교·정자·서현',          c: [127.1090, 37.3760], r: 1900 },
    { id: 'sel-jamsil', city: '서울', name: '잠실·송파',        sub: '롯데월드타워·석촌호수',    c: [127.1010, 37.5120], r: 1500 },
    { id: 'sel-yongsan',city: '서울', name: '용산·이태원',      sub: '용산역·이태원·한남',      c: [126.9950, 37.5330], r: 1600 },
    { id: 'sel-mapo',   city: '서울', name: '마포·상암',        sub: '공덕·DMC',               c: [126.9010, 37.5620], r: 1700 },

    // ───────── 서울 주요 대학가 ─────────
    { id: 'sel-sinchon',city: '서울', name: '신촌·홍대',        sub: '연세대·이대·서강대·홍익대', c: [126.9330, 37.5560], r: 1600 },
    { id: 'sel-anam',   city: '서울', name: '안암·고려대',      sub: '고려대·성신여대',         c: [127.0290, 37.5875], r: 1300 },
    { id: 'sel-snu',    city: '서울', name: '관악·서울대',      sub: '서울대·낙성대·샤로수길',   c: [126.9530, 37.4650], r: 1600 },
    { id: 'sel-daehak', city: '서울', name: '대학로·혜화',      sub: '성균관대·서울대병원',      c: [127.0020, 37.5820], r: 1200 },
    { id: 'sel-konkuk', city: '서울', name: '건대입구',         sub: '건국대·세종대·커먼그라운드', c: [127.0700, 37.5405], r: 1300 },
    { id: 'sel-hoegi',  city: '서울', name: '회기·이문',        sub: '경희대·한국외대·서울시립대', c: [127.0530, 37.5930], r: 1400 },
    { id: 'sel-heukseok',city:'서울', name: '흑석·중앙대',      sub: '중앙대·노들섬',           c: [126.9605, 37.5065], r: 1200 },
    { id: 'sel-wangsim',city: '서울', name: '왕십리·한양대',    sub: '한양대·성수',             c: [127.0435, 37.5570], r: 1400 },

    // ───────── 부산 ─────────
    { id: 'bsn-seomyeon', city: '부산', name: '서면',          sub: '서면·전포카페거리',       c: [129.0600, 35.1570], r: 1500 },
    { id: 'bsn-haeundae', city: '부산', name: '해운대',        sub: '해운대해수욕장·센텀',     c: [129.1620, 35.1620], r: 1600 },
    { id: 'bsn-nampo',    city: '부산', name: '남포·광복동',    sub: '자갈치·국제시장·부산역',   c: [129.0330, 35.0995], r: 1500 },
    { id: 'bsn-pnu',      city: '부산', name: '부산대·장전',    sub: '부산대학교·온천장',       c: [129.0840, 35.2310], r: 1300 },

    // ───────── 대구 ─────────
    { id: 'dgu-dongseong',city: '대구', name: '동성로',        sub: '중앙로·반월당·대구역',    c: [128.5945, 35.8690], r: 1500 },
    { id: 'dgu-knu',      city: '대구', name: '경북대·북구',    sub: '경북대학교·복현',         c: [128.6120, 35.8895], r: 1300 },

    // ───────── 인천 ─────────
    { id: 'icn-songdo',   city: '인천', name: '송도',          sub: '센트럴파크·국제업무지구',  c: [126.6420, 37.3925], r: 1700 },
    { id: 'icn-guwol',    city: '인천', name: '구월·인천시청',  sub: '로데오거리·인천터미널',   c: [126.7030, 37.4490], r: 1400 },
    { id: 'icn-inha',     city: '인천', name: '인하대·주안',    sub: '인하대학교',              c: [126.6545, 37.4505], r: 1300 },

    // ───────── 광주 ─────────
    { id: 'gwj-chungjang',city: '광주', name: '충장로·금남로',  sub: '광주 원도심',             c: [126.9135, 35.1490], r: 1400 },
    { id: 'gwj-jnu',      city: '광주', name: '전남대',        sub: '전남대학교·용봉',         c: [126.9000, 35.1760], r: 1300 },
    { id: 'gwj-sangmu',   city: '광주', name: '상무지구',      sub: '상무·치평',               c: [126.8480, 35.1520], r: 1300 },

    // ───────── 대전 ─────────
    { id: 'djn-dunsan',   city: '대전', name: '둔산·시청',      sub: '타임월드·정부청사',       c: [127.3800, 36.3520], r: 1500 },
    { id: 'djn-yuseong',  city: '대전', name: '유성·충남대',    sub: '충남대·KAIST·궁동',       c: [127.3450, 36.3680], r: 1700 },

    // ───────── 울산 ─────────
    { id: 'usn-samsan',   city: '울산', name: '삼산·울산시청',  sub: '삼산동·롯데백화점',       c: [129.3165, 35.5390], r: 1400 },
  ];

  /** 중심 + 반경(m) → [s, w, n, e] */
  function bboxOf(reg) {
    const [lng, lat] = reg.c;
    const dLat = reg.r / 111132;
    const dLng = reg.r / (111320 * Math.cos(lat * Math.PI / 180));
    return [lat - dLat, lng - dLng, lat + dLat, lng + dLng];
  }

  return { REGIONS, bboxOf };
});
