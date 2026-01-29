// lib/region-resolver.js  (ESM 버전)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 데이터 파일 경로
const L2A_PATH  = path.resolve(__dirname, 'legal_to_admin.json');
const IDX_PATH  = path.resolve(__dirname, 'legal_index_city_dong.json');
const NXNY_PATH = path.resolve(__dirname, 'nxny_map.json');
const ALIAS_PATH = path.resolve(__dirname, 'aliases.json');
const LIVING_PATH = path.resolve(__dirname, 'living_area_map.json');

// 로드
const l2a  = JSON.parse(fs.readFileSync(L2A_PATH,  'utf-8'));
const idx  = JSON.parse(fs.readFileSync(IDX_PATH,  'utf-8'));
const nxny = JSON.parse(fs.readFileSync(NXNY_PATH, 'utf-8'));
const aliases = fs.existsSync(ALIAS_PATH)
  ? JSON.parse(fs.readFileSync(ALIAS_PATH, 'utf-8'))
  : {};
const livingArea = fs.existsSync(LIVING_PATH)
  ? JSON.parse(fs.readFileSync(LIVING_PATH, 'utf-8'))
  : { byAdminKey: {}, byNxNy: {} };

const CITY_ALIASES = {
  "\uC11C\uC6B8": "\uC11C\uC6B8\uD2B9\uBCC4\uC2DC",
  "\uBD80\uC0B0": "\uBD80\uC0B0\uAD11\uC5ED\uC2DC",
  "\uB300\uAD6C": "\uB300\uAD6C\uAD11\uC5ED\uC2DC",
  "\uC778\uCC9C": "\uC778\uCC9C\uAD11\uC5ED\uC2DC",
  "\uAD11\uC8FC": "\uAD11\uC8FC\uAD11\uC5ED\uC2DC",
  "\uB300\uC804": "\uB300\uC804\uAD11\uC5ED\uC2DC",
  "\uC6B8\uC0B0": "\uC6B8\uC0B0\uAD11\uC5ED\uC2DC",
  "\uC138\uC885": "\uC138\uC885\uD2B9\uBCC4\uC790\uCE58\uC2DC",
  "\uAC15\uC6D0": "\uAC15\uC6D0\uD2B9\uBCC4\uC790\uCE58\uB3C4",
  "\uAC15\uC6D0\uB3C4": "\uAC15\uC6D0\uD2B9\uBCC4\uC790\uCE58\uB3C4",
  "\uC804\uBD81": "\uC804\uBD81\uD2B9\uBCC4\uC790\uCE58\uB3C4",
  "\uC804\uBD81\uB3C4": "\uC804\uBD81\uD2B9\uBCC4\uC790\uCE58\uB3C4",
  "\uC804\uB77C\uBD81\uB3C4": "\uC804\uBD81\uD2B9\uBCC4\uC790\uCE58\uB3C4",
  "\uC81C\uC8FC": "\uC81C\uC8FC\uD2B9\uBCC4\uC790\uCE58\uB3C4",
  "\uC81C\uC8FC\uB3C4": "\uC81C\uC8FC\uD2B9\uBCC4\uC790\uCE58\uB3C4"
};

const normCity = s => CITY_ALIASES[s] || s;

const DETAIL_RE = /(\uC74D|\uBA74|\uB3D9|\uB9AC|\uAC00)$/;
const SUGGEST_RE = /(\uC74D|\uBA74|\uB3D9|\uAC00)$/;
const CITY_SUFFIX_RE = /(\uC2DC|\uAD70|\uAD6C)$/;

const isDetail = (token) => DETAIL_RE.test(token || "");

function resolveAreaNo(adminKey, coords) {
  const byAdmin = livingArea?.byAdminKey?.[adminKey];
  if (byAdmin) return byAdmin;
  if (coords?.nx != null && coords?.ny != null) {
    const k = `${coords.nx},${coords.ny}`;
    return livingArea?.byNxNy?.[k] || null;
  }
  return null;
}

function resolveCityKey(siDo, token) {
  if (!siDo || !token) return null;
  const base = `${siDo} ${token}`;
  if (idx[base]) return base;
  if (!CITY_SUFFIX_RE.test(token)) {
    const withGun = `${siDo} ${token}\uAD70`;
    if (idx[withGun]) return withGun;
    const withSi = `${siDo} ${token}\uC2DC`;
    if (idx[withSi]) return withSi;
    const withGu = `${siDo} ${token}\uAD6C`;
    if (idx[withGu]) return withGu;
  }
  return null;
}

function resolveAdminKey(key) {
  if (nxny[key]) return key;
  const parts = key.split(' ');
  if (parts.length >= 3) {
    const last = parts[parts.length - 1];
    if (CITY_SUFFIX_RE.test(last)) {
      const merged = [...parts.slice(0, -2), parts[parts.length - 2] + last].join(' ');
      if (nxny[merged]) return merged;
    }
  }
  return null;
}


function buildCitySuggestions(cityKey, limit = 10) {
  const out = [];
  const seen = new Set();

  const pushIfValid = (key) => {
    const resolved = resolveAdminKey(key);
    if (!resolved) return;
    if (seen.has(resolved)) return;
    seen.add(resolved);
    out.push(key);
  };

  if (nxny[cityKey]) pushIfValid(cityKey);

  const list = idx[cityKey] || [];
  const base = list.filter((v) => SUGGEST_RE.test(v));

  const addFromNames = (parentKey, names) => {
    for (const name of names) {
      const legalKey = combine(parentKey, name);
      const admins = l2a[legalKey] || [];
      for (const adminKey of admins) {
        pushIfValid(adminKey);
        if (out.length >= limit) return true;
      }
    }
    return false;
  };

  if (base.length) {
    addFromNames(cityKey, base);
    return out.slice(0, limit);
  }

  const subKeys = Object.keys(idx).filter(k => k.startsWith(`${cityKey} `));
  if (subKeys.length) {
    for (const subKey of subKeys) {
      pushIfValid(subKey);
      if (out.length >= limit) return out;
    }
    for (const subKey of subKeys) {
      const subList = idx[subKey] || [];
      const subBase = subList.filter((v) => SUGGEST_RE.test(v));
      if (subBase.length && addFromNames(subKey, subBase)) return out;
    }
    return out;
  }

  addFromNames(cityKey, list);
  return out;
}

function parseQuery(raw) {
  const a = String(raw||'').trim();
  if (aliases[a]) return { aliasTarget: aliases[a] }; // 별칭 직행
  const parts = a.replace(/\s+/g,' ').split(' ');
  let siDo, siGunGu, dong;
  if (parts.length === 3) { siDo=normCity(parts[0]); siGunGu=parts[1]; dong=parts[2]; }
  else if (parts.length === 2) {
    if (/(구|군)$/.test(parts[0])) { siGunGu=parts[0]; dong=parts[1]; }
    else { siDo=normCity(parts[0]); dong=parts[1]; }
  } else {
    const token = parts[0];
    const city = normCity(token);
    if (CITY_ALIASES[token] || /(\uB3C4|\uC2DC|\uAD11\uC5ED\uC2DC|\uD2B9\uBCC4\uC2DC|\uD2B9\uBCC4\uC790\uCE58\uB3C4)$/.test(token)) {
      siDo = city;
    } else {
      dong = token;
    }
  }
  return { siDo, siGunGu, dong };
}
const combine = (cityKey, dong) => `${cityKey} ${dong}`.replace(/\s+/g,' ').trim();

export function resolveRegion(userText) {
  // 0) 별칭 직행
  if (aliases[userText]) {
    const t = aliases[userText].trim().replace(/\s+/g,' ');
    const parts = t.split(' ');
    const cityKey = parts.slice(0,2).join(' ');
    const dong = parts.slice(2).join(' ');
    const legalKey = combine(cityKey, dong);
    const as = l2a[legalKey];
    if (as && as.length) {
      const adminKey = as[0];
      const resolvedAdmin = resolveAdminKey(adminKey);
      if (resolvedAdmin) return { ok:true, match:'alias->legal->admin', legalKey, adminKey: resolvedAdmin, nxny:nxny[resolvedAdmin], areaNo: resolveAreaNo(resolvedAdmin, nxny[resolvedAdmin]) };
    }
  }

  const { siDo, siGunGu, dong } = parseQuery(userText);
  if (!dong) {
    if (siDo) {
      const suggestions = buildCitySuggestions(siDo);
      return { ok:false, reason:'NO_DONG', suggestions };
    }
    return { ok:false, reason:'NO_DONG', suggestions:[] };
  }

  // 1) 완전 행정동 키 매칭
  if (siDo && siGunGu) {
    const adminKey = combine(`${siDo} ${siGunGu}`, dong);
    const resolvedAdmin = resolveAdminKey(adminKey);
    if (resolvedAdmin) return { ok:true, match:'admin-exact', adminKey: resolvedAdmin, nxny:nxny[resolvedAdmin], areaNo: resolveAreaNo(resolvedAdmin, nxny[resolvedAdmin]) };
  }

  if (siDo && siGunGu && !isDetail(dong)) {
    const districtKey = `${siDo} ${siGunGu} ${dong}`;
    if (idx[districtKey] || nxny[districtKey]) {
      const suggestions = buildCitySuggestions(districtKey);
      if (suggestions.length) {
        return { ok:false, reason:'NO_DONG', suggestions };
      }
    }
    const cityKey = `${siDo} ${siGunGu}`;
    const suggestions = buildCitySuggestions(cityKey);
    if (suggestions.length) {
      return { ok:false, reason:'NO_DONG', suggestions };
    }
  }

  if (siDo && !siGunGu && !isDetail(dong)) {
    const cityKey = resolveCityKey(siDo, dong);
    if (cityKey) {
      const suggestions = buildCitySuggestions(cityKey);
      if (suggestions.length) {
        return { ok:false, reason:'NO_DONG', suggestions };
      }
    }
  }

  // 2) 시도만 주어진 경우
  if (siDo && !siGunGu) {
    const cities = Object.keys(idx).filter(k => k.startsWith(siDo+' '));
    for (const c of cities) {
      const legalKey = combine(c, dong);
      const as = l2a[legalKey];
      if (as && as.length) {
        const adminKey = as[0];
        const resolvedAdmin = resolveAdminKey(adminKey);
        if (resolvedAdmin) return { ok:true, match:'legal->admin', legalKey, adminKey: resolvedAdmin, nxny:nxny[resolvedAdmin], areaNo: resolveAreaNo(resolvedAdmin, nxny[resolvedAdmin]) };
      }
    }
  }

  // 3) 시군구만 주어진 경우
  if (!siDo && siGunGu) {
    const cities = Object.keys(idx).filter(k => k.endsWith(' '+siGunGu) || k===siGunGu);
    for (const c of cities) {
      const legalKey = combine(c, dong);
      const as = l2a[legalKey];
      if (as && as.length) {
        const adminKey = as[0];
        const resolvedAdmin = resolveAdminKey(adminKey);
        if (resolvedAdmin) return { ok:true, match:'legal->admin', legalKey, adminKey: resolvedAdmin, nxny:nxny[resolvedAdmin], areaNo: resolveAreaNo(resolvedAdmin, nxny[resolvedAdmin]) };
      }
    }
  }

  // 4) 시도는 맞고 구만 틀렸을 때 자동 보정
  if (siDo && siGunGu) {
    const sameCity = Object.keys(idx).filter(k => k.startsWith(siDo+' '));
    const candidates = [];
    for (const c of sameCity) {
      const legalKey = combine(c, dong);
      if (l2a[legalKey]) candidates.push({ legalKey, admins: l2a[legalKey] });
    }
    if (candidates.length === 1) {
      const adminKey = candidates[0].admins[0];
      const resolvedAdmin = resolveAdminKey(adminKey);
      if (resolvedAdmin) {
        return { ok:true, match:'auto-corrected-gu', legalKey: candidates[0].legalKey, adminKey: resolvedAdmin, nxny:nxny[resolvedAdmin], areaNo: resolveAreaNo(resolvedAdmin, nxny[resolvedAdmin]) };
      }
    }
  }

  // 5) 근사 후보
  const suggestions = Object.keys(nxny)
    .filter(k => (!siDo || k.startsWith(siDo)) && (k.endsWith(' '+dong) || k.endsWith(dong)))
    .slice(0, 10);
  return { ok:false, reason:'NOT_FOUND', suggestions };
}

// (호환용 default export)
export default { resolveRegion };
