/* sun.js — SunCalc 래퍼: 태양 위치 → 그림자 방향/길이 계수 */
window.SW = window.SW || {};
SW.sun = (function () {
  const R2D = 180 / Math.PI;

  // SunCalc azimuth: 0=남쪽, +방향 서쪽 (라디안).
  // 그림자는 태양 반대편이므로, "북쪽 기준 시계방향 그림자 방위각" = azimuth 그대로.
  //  (태양이 남쪽(az=0)이면 그림자는 북쪽=방위 0 ✓, 태양이 서쪽(az=π/2)이면 그림자는 동쪽=방위 90° ✓)

  // 높이 1m당 그림자 변위 벡터(동쪽 ux, 북쪽 uy) [m]
  function shadowUnit(date, lat, lng) {
    const p = SunCalc.getPosition(date, lat, lng);
    const altDeg = p.altitude * R2D;
    if (altDeg <= 0.3) return { night: true, full: true, altDeg };
    const full = altDeg < 2.5; // 해가 지평선에 붙으면 사실상 전 구간 그늘 취급
    let k = 1 / Math.tan(p.altitude);
    if (k > 18) k = 18; // 렌더링 안정화를 위한 상한 (높이 10m → 그림자 최대 180m)
    return {
      night: false, full, altDeg,
      ux: Math.sin(p.azimuth) * k,
      uy: Math.cos(p.azimuth) * k,
    };
  }

  function pos(date, lat, lng) {
    const p = SunCalc.getPosition(date, lat, lng);
    return { altDeg: p.altitude * R2D, azimuth: p.azimuth };
  }

  function times(date, lat, lng) { return SunCalc.getTimes(date, lat, lng); }

  return { shadowUnit, pos, times };
})();
