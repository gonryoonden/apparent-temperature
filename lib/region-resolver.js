// lib/region-resolver.js
const fs = require('fs');
const path = require('path');

const L2A_PATH = path.resolve(__dirname, 'legal_to_admin.json');
const IDX_PATH = path.resolve(__dirname, 'legal_index_city_dong.json');
const NXNY_PATH = path.resolve(__dirname, 'nxny_map.json');

const l2a = JSON.parse(fs.readFileSync(L2A_PATH, 'utf-8'));       // 법정동 → [행정동...]
const idx = JSON.parse(fs.readFileSync(IDX_PATH, 'utf-8'));       // "시도 시군구" → [법정동...]
const nxny = JSON.parse(fs.readFileSync(NXNY_PATH, 'utf-8'));     // 행정동키 → {nx, ny}

const CITY_ALIASES = {
  "서울": "서울특별시", "부산": "부산광역시", "대구": "대구광역시",
  "인천": "인천광역시", "광주": "광주광역시", "대전": "대전광역시",
  "울산": "울산광역시", "세종": "세종특별자치시"
};

function normCity(s) {
  const t = String(s || '').trim();
  return CITY_ALIASES[t] || t;
}

function parseQuery(raw) {
  const parts = String(raw || '').replace(/\s+/g, ' ').trim().split(' ');
  let siDo, siGunGu, dong;
  if (parts.length === 3) {
    siDo = normCity(parts[0]); siGunGu = parts[1]; dong = parts[2];
  } else if (parts.length === 2) {
    if (/(구|군)$/.test(parts[0])) { siGunGu = parts[0]; dong = parts[1]; }
    else { siDo = normCity(parts[0]); dong = parts[1]; }
  } else {
    dong = parts[0];
  }
  return { siDo, siGunGu, dong };
}

function combine(cityKey, dong) {
  return `${cityKey} ${dong}`.replace(/\s+/g, ' ').trim();
}

function resolveRegion(userText) {
  const { siDo, siGunGu, dong } = parseQuery(userText);
  if (!dong) {
    return { ok: false, reason: 'NO_DONG', suggestions: [] };
  }

  // 0) 완전한 행정동 키로 바로 매칭 시도
  if (siDo && siGunGu) {
    const adminKey = combine(`${siDo} ${siGunGu}`, dong);
    if (nxny[adminKey]) {
      return { ok: true, match: 'admin-exact', adminKey, nxny: nxny[adminKey] };
    }
  }

  // 1) 시도만 주어진 경우 (예: "대전 와동") → 해당 시도의 모든 시군구 후보 확장 후 l2a 매칭
  if (siDo && !siGunGu) {
    const cities = Object.keys(idx).filter(k => k.startsWith(siDo + ' '));
    for (const c of cities) {
      const legalKey = combine(c, dong);      // "대전광역시 대덕구 와동"
      const admins = l2a[legalKey];
      if (admins && admins.length) {
        // 보통 1개 (예: 와동 -> 회덕동)
        const adminKey = admins[0];
        const grid = nxny[adminKey];
        if (grid) return { ok: true, match: 'legal->admin', legalKey, adminKey, nxny: grid };
      }
    }
  }

  // 2) 시군구만 주어진 경우 (예: "대덕구 와동") → idx에서 시군구로 도시 후보 찾기
  if (!siDo && siGunGu) {
    const cities = Object.keys(idx).filter(k => k.endsWith(' ' + siGunGu) || k === siGunGu);
    for (const c of cities) {
      const legalKey = combine(c, dong);
      const admins = l2a[legalKey];
      if (admins && admins.length) {
        const adminKey = admins[0];
        const grid = nxny[adminKey];
        if (grid) return { ok: true, match: 'legal->admin', legalKey, adminKey, nxny: grid };
      }
    }
  }

  // 3) 완전한 법정동 키가 온 경우
  if (siDo && siGunGu) {
    const legalKey = combine(`${siDo} ${siGunGu}`, dong);
    const admins = l2a[legalKey];
    if (admins && admins.length) {
      for (const a of admins) {
        if (nxny[a]) return { ok: true, match: 'legal->admin', legalKey, adminKey: a, nxny: nxny[a] };
      }
    }
  }

  // 4) 근사 후보 제시
  const suggestions = Object.keys(nxny)
    .filter(k => (!siDo || k.startsWith(siDo)) && k.endsWith(' ' + dong))
    .slice(0, 10);
  return { ok: false, reason: 'NOT_FOUND', suggestions };
}

module.exports = { resolveRegion };
