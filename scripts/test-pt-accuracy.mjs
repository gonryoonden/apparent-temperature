// scripts/test-pt-accuracy.mjs
import { perceivedTempKMA } from '../lib/ptCore.js';

const cases = [
  { Ta:30.0, RH:70, expect:31.3, tol:0.1 },
  { Ta:33.0, RH:60, expect:33.5, tol:0.1 },
  { Ta:28.0, RH:80, expect:30.0, tol:0.1 },
  { Ta:35.0, RH:40, expect:33.3, tol:0.1 }
];

let pass = 0;
for (const c of cases) {
  const v = perceivedTempKMA(c.Ta, c.RH);
  const ok = Math.abs(v - c.expect) <= c.tol;
  console.log(`Ta=${c.Ta}, RH=${c.RH} => PT=${v.toFixed(1)} (exp≈${c.expect}, tol±${c.tol}) ${ok?'✓':'✗'}`);
  if (ok) pass++;
}
console.log(`passed ${pass}/${cases.length}`);
process.exit(pass===cases.length ? 0 : 1);