// scripts/invoke-api.mjs
import 'dotenv/config';

function mockRes() {
  return {
    _code: 200,
    _body: null,
    status(c){ this._code=c; return this; },
    json(b){ this._body=b; console.log(JSON.stringify({status:this._code, ...b}, null, 2)); }
  };
}

const mode = process.argv[2] || "pt";
const region = process.argv.slice(3).join(' ') || "대전 와동";

const req = { query: { region }, body: {} };
const res = mockRes();

if (mode === "pt") {
  const mod = await import("../api/pt.js");              // ← 동적 import
  await mod.default(req, res);
} else {
  const mod = await import("../api/pt-forecast.js");     // ← 동적 import
  await mod.default(req, res);
}