import { parseLatLon, latlonToGrid } from "../lib/geo.js";
import { resolveRegion } from "../lib/region-resolver.js";
import { resolveWarningsMapping } from "../lib/services/warningsMapper.js";
import { getWarningsNormalized } from "../lib/services/warningsService.js";

function getScalar(q) {
  if (Array.isArray(q)) return null;
  if (q === undefined || q === null) return null;
  return String(q);
}
function parseBool(s) {
  if (typeof s === "boolean") return s;
  return typeof s === "string" && s.toLowerCase() === "true";
}

export default async function handler(req, res) {
  try {
    const region = (getScalar(req.query.region) || getScalar(req.query.q) || "").trim();
    const stnId = (getScalar(req.query.stnId) || "").trim();
    const areaCode = (getScalar(req.query.areaCode) || "").trim();
    const from = (getScalar(req.query.from) || "").trim();
    const to = (getScalar(req.query.to) || "").trim();
    const warningType = (getScalar(req.query.warningType) || "").trim();
    const detail = parseBool(getScalar(req.query.detail) || "false");

    const latlon = parseLatLon(req.query.lat, req.query.lon);
    const hasLatlon = latlon.ok;

    let nx, ny, adminKey = null;
    let resolvedRegion = region || null;

    if (region) {
      const r = resolveRegion(region);
      if (r.ok) {
        adminKey = r.adminKey || null;
        if (!hasLatlon) {
          nx = r.nxny.nx;
          ny = r.nxny.ny;
        }
        resolvedRegion = r.adminKey || region;
      } else if (!hasLatlon && !stnId && !areaCode) {
        return res.status(200).json({
          ok: false,
          reason: r.reason,
          suggestions: r.suggestions || [],
        });
      }
    }

    if (hasLatlon) {
      const grid = latlonToGrid(latlon.lat, latlon.lon);
      nx = grid?.nx ?? null;
      ny = grid?.ny ?? null;
      if (!resolvedRegion) resolvedRegion = `${latlon.lat},${latlon.lon}`;
    }

    if (!region && !hasLatlon && !stnId && !areaCode) {
      return res.status(200).json({
        ok: false,
        error: "region, lat/lon, stnId, areaCode 중 하나는 필요합니다.",
      });
    }

    const mapping = resolveWarningsMapping({ adminKey, nx, ny, stnId, areaCode });
    if (!mapping?.stnId && !mapping?.areaCode) {
      return res.status(200).json({
        ok: false,
        error: "특보 지점 매핑 실패",
      });
    }

    const warnings = await getWarningsNormalized({
      stnId: mapping.stnId,
      areaCode: mapping.areaCode || areaCode || undefined,
      from: from || undefined,
      to: to || undefined,
      warningType: warningType || undefined,
      detail,
    });

    const summary = {
      ...warnings.summary,
      areaCode: mapping.areaCode || null,
      areaName: mapping.areaName || null,
    };

    return res.status(200).json({
      ok: true,
      region: resolvedRegion,
      grid: nx != null && ny != null ? { nx, ny } : null,
      mapping,
      items: warnings.items,
      summary,
      cache: warnings.cache,
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      reason: "internal_error",
      message: String(err?.message || err),
    });
  }
}
