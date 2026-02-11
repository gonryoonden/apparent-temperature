import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { latlonToGrid: latlonToGridCjs } = require("./kmaGrid.js");

export function parseLatLon(lat, lon) {
  if (lat === undefined || lon === undefined || lat === null || lon === null) {
    return { ok: false, reason: "missing" };
  }
  const nlat = Number(lat);
  const nlon = Number(lon);
  if (!Number.isFinite(nlat) || !Number.isFinite(nlon)) {
    return { ok: false, reason: "nan" };
  }
  if (nlat < -90 || nlat > 90 || nlon < -180 || nlon > 180) {
    return { ok: false, reason: "range" };
  }
  return { ok: true, lat: nlat, lon: nlon };
}

export function latlonToGrid(lat, lon) {
  return latlonToGridCjs(lat, lon);
}

