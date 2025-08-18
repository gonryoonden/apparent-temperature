/**
 * scripts/pt_parity_test.js
 * 목적: ../lib/pt (legacy) 의 perceivedTemp 와 현재 KMA2016 계산의 동등성 확인
 * 사용법: node scripts/pt_parity_test.js
 * 출력: 최대/평균 오차, 실패 샘플 (허용오차 PT_EPSILON=0.1 권장)
 */
import { perceivedTemp as legacyPT } from "../lib/pt.js";

function perceivedTempKMA(Ta, RH) {
  const Tw =
    Ta * Math.atan(0.151977 * Math.sqrt(RH + 8.313659)) +
    Math.atan(Ta + RH) -
    Math.atan(RH - 1.676331) +
    0.00391838 * Math.pow(RH, 1.5) * Math.atan(0.023101 * RH) -
    4.686035;
  const PT =
    -0.2442 + 0.55399 * Tw + 0.45535 * Ta - 0.0022 * Tw * Tw + 0.00278 * Tw * Ta + 3.0;
  return Math.round(PT * 10) / 10;
}

const EPS = 0.1;
let maxDiff = 0;
let sumDiff = 0;
let n = 0;
const fails = [];

for (let Ta = 25; Ta <= 40; Ta += 0.5) {
  for (let RH = 30; RH <= 90; RH += 5) {
    const a = perceivedTempKMA(Ta, RH);
    const b = Math.round(legacyPT(Ta, RH) * 10) / 10;
    const d = Math.abs(a - b);
    maxDiff = Math.max(maxDiff, d);
    sumDiff += d;
    n++;
    if (d > EPS) fails.push({ Ta, RH, a, b, d });
  }
}

console.log({
  samples: n,
  meanAbsDiff: +(sumDiff / n).toFixed(3),
  maxDiff: +maxDiff.toFixed(3),
  epsilon: EPS,
  pass: fails.length === 0,
  fails: fails.slice(0, 10), // 최대 10건 미리보기
});
