// scripts/notify-risk.mjs
import fs from "fs";
import path from "path";

function loadConfig() {
  if (fs.existsSync("config/notify.json")) {
    try {
      return JSON.parse(fs.readFileSync("config/notify.json", "utf-8"));
    } catch {
      return {};
    }
  }
  return {};
}

function loadState(statePath) {
  if (!fs.existsSync(statePath)) return { lastSent: {} };
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf-8"));
  } catch {
    return { lastSent: {} };
  }
}

function saveState(statePath, state) {
  const dir = path.dirname(statePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
}

function parseRegions(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  const s = String(input).trim();
  if (!s) return [];
  if (s.startsWith("[")) {
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }
  return s.split(",").map((t) => t.trim()).filter(Boolean).map((region) => ({ region }));
}

function buildRiskUrl(base, item) {
  const url = new URL("/api/risk", base);
  if (item.region) url.searchParams.set("region", item.region);
  if (item.lat != null) url.searchParams.set("lat", item.lat);
  if (item.lon != null) url.searchParams.set("lon", item.lon);
  return url.toString();
}

function dedupeKey(item, payload) {
  const loc = item.region
    ? `region:${item.region}`
    : `latlon:${item.lat},${item.lon}`;
  const level = payload?.risk?.level || "unknown";
  const warn = payload?.warnings?.highestLevel || "none";
  return `${loc}|${level}|${warn}`;
}

async function postWebhook(webhookUrl, payload) {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Webhook failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

async function main() {
  const cfg = loadConfig();
  const webhookUrl = cfg.webhookUrl || process.env.ALERT_WEBHOOK_URL;
  const apiBase = cfg.apiBase || process.env.ALERT_API_BASE || "http://localhost:3000";
  const threshold = Number(cfg.threshold ?? process.env.ALERT_THRESHOLD ?? 60);
  const dedupeMinutes = Number(cfg.dedupeMinutes ?? process.env.ALERT_DEDUPE_MINUTES ?? 60);
  const statePath = cfg.statePath || process.env.ALERT_STATE_PATH || "data/notify_state.json";
  const regions = cfg.regions || parseRegions(process.env.ALERT_REGIONS);

  if (!webhookUrl) throw new Error("ALERT_WEBHOOK_URL 또는 config/notify.json webhookUrl 필요");
  if (!regions.length) throw new Error("ALERT_REGIONS 또는 config/notify.json regions 필요");

  const alerts = [];
  const state = loadState(statePath);
  const lastSent = state.lastSent || {};
  const nowMs = Date.now();
  const cooldownMs = dedupeMinutes * 60 * 1000;
  let suppressed = 0;
  for (const item of regions) {
    const url = buildRiskUrl(apiBase, item);
    const res = await fetch(url);
    const json = await res.json();
    if (json?.ok && json?.risk?.score >= threshold) {
      const key = dedupeKey(item, json);
      const last = Number(lastSent[key] || 0);
      if (cooldownMs > 0 && last && nowMs - last < cooldownMs) {
        suppressed += 1;
        continue;
      }
      alerts.push({ input: item, risk: json.risk, warnings: json.warnings, metrics: json.metrics, _dedupeKey: key });
    }
  }

  if (!alerts.length) {
    console.log("no alerts");
    return;
  }

  await postWebhook(webhookUrl, {
    ts: new Date().toISOString(),
    threshold,
    alerts,
  });
  const nextState = { lastSent: { ...lastSent } };
  for (const a of alerts) {
    nextState.lastSent[a._dedupeKey] = nowMs;
    delete a._dedupeKey;
  }
  saveState(statePath, nextState);
  console.log(`sent ${alerts.length} alerts (suppressed ${suppressed})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
