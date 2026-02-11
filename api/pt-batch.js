import ptHandler from "./pt.js";

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

class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "TimeoutError";
  }
}

function withTimeout(promise, ms) {
  if (!ms || ms <= 0) return promise;
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new TimeoutError("batch item timeout")), ms)
    ),
  ]);
}

async function runWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  const worker = async () => {
    while (true) {
      const cur = idx++;
      if (cur >= items.length) return;
      results[cur] = await fn(items[cur], cur);
    }
  };
  const size = Math.max(1, Math.min(limit, items.length));
  await Promise.all(new Array(size).fill(0).map(worker));
  return results;
}

export default async function handler(req, res) {
  const body = req.body || {};
  const regions = Array.isArray(body.regions) ? body.regions : [];
  if (!regions.length) {
    return res.status(200).json({ ok: false, error: "regions 배열이 필요합니다." });
  }
  const normalizeWarnings = (v) => {
    const w = String(v || "summary").toLowerCase();
    return ["summary", "full", "none"].includes(w) ? w : "summary";
  };
  const defaultWarnings = normalizeWarnings(body.warnings || req.query?.warnings || "summary");

  const concurrency = Number(body.concurrency || process.env.BATCH_CONCURRENCY || 4);
  const timeoutMs = Number(body.timeoutMs || process.env.BATCH_TIMEOUT_MS || 8000);

  const results = await runWithConcurrency(regions, concurrency, async (item) => {
    const query = {};
    if (item.region) query.region = item.region;
    if (item.lat != null) query.lat = item.lat;
    if (item.lon != null) query.lon = item.lon;
    query.warnings = normalizeWarnings(item.warnings || defaultWarnings || "summary");

    try {
      const out = await withTimeout(invokeHandler(ptHandler, { query }), timeoutMs);
      return { input: item, result: out.data, status: out.statusCode };
    } catch (e) {
      const reason = e?.name === "TimeoutError" ? "timeout" : "internal_error";
      return { input: item, result: { ok: false, reason, message: String(e?.message || e) }, status: 200 };
    }
  });

  return res.status(200).json({
    ok: true,
    count: results.length,
    results,
  });
}
