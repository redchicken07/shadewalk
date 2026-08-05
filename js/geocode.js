/* geocode.js — 장소 검색 (건물명·상가명·지하철역)
 *
 * 검색어를 외부 서버에 보내지 않는다. 그림자 계산용으로 이미 받아 둔 지역 데이터에
 * 이름 있는 장소가 함께 들어 있어서, 그 안에서 바로 찾는다.
 *   · 결과가 즉시 나온다 (네트워크 왕복 없음)
 *   · 호출 제한·이용약관·비용 문제가 없다
 *   · 비행기 모드에서도 동작한다
 * 대신 미리 구워 둔 지역 안의 장소만 찾을 수 있다.
 */
window.SW = window.SW || {};
SW.geo = (function () {

  const kmBetween = (a, b) =>
    Math.hypot((b[1] - a[1]) * 111, (b[0] - a[0]) * 111 * Math.cos(a[1] * Math.PI / 180));

  // 검색 편의를 위한 표기 흔들림 흡수: 공백/가운뎃점 제거, 소문자화
  function norm(s) { return String(s).toLowerCase().replace(/[\s·・.,()\-]/g, ''); }

  // "강남역" 으로 찾을 때 "강남" 으로 태그된 역도 걸리도록
  const SUFFIX = /(역|사거리|삼거리|공원|캠퍼스|점|타워|빌딩|센터)$/;

  function matchScore(name, q, qn) {
    const n = name.toLowerCase(), nn = norm(name);
    if (n === q || nn === qn) return 100;
    if (nn.startsWith(qn)) return 84;
    if (nn.includes(qn)) return 66;
    const qs = qn.replace(SUFFIX, '');
    if (qs.length >= 2 && nn.startsWith(qs)) return 58;
    if (qs.length >= 2 && nn.includes(qs)) return 40;
    return 0;
  }

  // 검색 결과로서의 쓸모 — 역·공원·학교가 카페보다 먼저 나오는 게 자연스럽다
  const KIND_BONUS = {
    station: 22, halt: 20, subway_entrance: 18, platform: 12, stop: 8,
    park: 16, university: 16, college: 14, school: 10, hospital: 12,
    library: 10, museum: 10, theatre: 8, mall: 12, department_store: 12,
    supermarket: 6, townhall: 8, bank: 2, cafe: 2, restaurant: 1,
  };

  const KIND_LABEL = {
    station: '역', halt: '역', subway_entrance: '지하철 출입구', platform: '승강장', stop: '정류장',
    bus_station: '버스터미널', park: '공원', garden: '정원', playground: '놀이터',
    university: '대학교', college: '대학', school: '학교', kindergarten: '유치원',
    hospital: '병원', clinic: '의원', doctors: '병원', dentist: '치과', pharmacy: '약국',
    library: '도서관', museum: '박물관', theatre: '극장', cinema: '영화관',
    arts_centre: '문화센터', exhibition_centre: '전시장', community_centre: '주민센터',
    mall: '쇼핑몰', department_store: '백화점', supermarket: '마트', convenience: '편의점',
    marketplace: '시장', cafe: '카페', restaurant: '음식점', fast_food: '패스트푸드',
    bakery: '베이커리', bar: '바', pub: '펍', bank: '은행', hotel: '호텔', motel: '모텔',
    post_office: '우체국', townhall: '시청·구청', police: '경찰서', fire_station: '소방서',
    place_of_worship: '종교시설', fuel: '주유소', parking: '주차장', sports_centre: '체육관',
    fitness_centre: '헬스장', swimming_pool: '수영장', stadium: '경기장', attraction: '명소',
    viewpoint: '전망대', hostel: '게스트하우스', books: '서점', clothes: '의류',
    electronics: '전자제품', furniture: '가구', optician: '안경점', florist: '꽃집',
  };

  // 한 역에 딸린 승강장·출입구는 이름이 같으므로 하나로 묶는다
  const TRANSIT = new Set(['platform', 'stop', 'subway_entrance', 'halt', 'station', 'bus_station']);

  // 사전에 없는 영어 태그를 그대로 보여 주면 오히려 어수선하다
  function label(kind) {
    if (KIND_LABEL[kind]) return KIND_LABEL[kind];
    return /^[a-z_]+$/.test(kind || '') ? '' : (kind || '');
  }

  /**
   * 현재 지역 데이터 안에서 검색한다. 동기 함수지만 호출부와의 호환을 위해
   * Promise를 돌려준다(onPartial은 즉시 한 번 불린다).
   */
  async function search(qRaw, center, onPartial) {
    const q = (qRaw || '').trim().toLowerCase();
    if (q.length < 1) return [];
    const qn = norm(q);
    if (!qn) return [];

    const data = SW.state && SW.state.data;
    const pois = (data && data.pois) || [];
    const c = center || [126.978, 37.5665];

    const hits = [];
    for (const p of pois) {
      const ms = matchScore(p.name, q, qn);
      if (!ms) continue;
      const km = kmBetween(c, p.ll);
      hits.push({
        p, km,
        // 이름 일치 + 가까움 + 장소 종류의 쓸모
        score: ms + 34 * Math.exp(-km / 2.2) + (KIND_BONUS[p.kind] || 0),
      });
    }

    // 같은 곳이 여러 노드로 잡히는 걸 정리한다.
    //  · 역·정류장: 승강장 폴 하나하나가 다 잡히므로 이름당 가장 가까운 것 하나만
    //  · 그 외: 200m 안에 같은 이름이 있으면 같은 곳, 더 멀면 다른 지점(체인점)이라 남긴다
    hits.sort((a, b) => b.score - a.score);
    const out = [], kept = [];
    for (const h of hits) {
      const key = norm(h.p.name);
      const transit = TRANSIT.has(h.p.kind);
      const dup = kept.some(k => k.key === key &&
        ((transit && k.transit) || kmBetween(k.ll, h.p.ll) < 0.2));
      if (dup) continue;
      kept.push({ key, ll: h.p.ll, transit });
      out.push({
        name: h.p.name,
        detail: label(h.p.kind),
        dist: h.km < 1 ? Math.round(h.km * 1000) + 'm' : h.km.toFixed(1) + 'km',
        full: h.p.name,
        ll: h.p.ll,
        src: 'local',
      });
      if (out.length >= 8) break;
    }

    if (onPartial) onPartial(out, true);
    return out;
  }

  return { search };
})();
