import ptHandler from "./pt.js";
import { computeRisk } from "../lib/risk.js";

function invokeHandler(handler, { query, body } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(data) {
        resolve({ statusCode: this.statusCode, data });
      },
    };
    handler({ query: query || {}, body }, res);
  });
}

export default async function handler(req, res) {
  const query = { ...req.query, warnings: "summary" };
  const out = await invokeHandler(ptHandler, { query });
  const pt = out.data;
  if (!pt?.ok) {
    return res.status(200).json({ ok: false, reason: "pt_error", pt });
  }
  const warnings = pt.warnings || null;
  const risk = computeRisk({
    apparentTemperature: pt.metrics?.apparentTemperature,
    hazards: pt.hazards,
    warnings,
  });
  return res.status(200).json({
    ok: true,
    region: pt.region,
    grid: pt.grid,
    observedAtKst: pt.observedAtKst,
    metrics: pt.metrics,
    hazards: pt.hazards,
    warnings,
    risk,
  });
}

