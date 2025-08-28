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

// 로드
const l2a  = JSON.parse(fs.readFileSync(L2A_PATH,  'utf-8'));
const idx  = JSON.parse(fs.readFileSync(IDX_PATH,  'utf-8'));
const nxny = JSON.parse(fs.readFileSync(NXNY_PATH, 'utf-8'));
const aliases = fs.existsSync(ALIAS_PATH)
  ? JSON.parse(fs.readFileSync(ALIAS_PATH, 'utf-8'))
  : {};

const CITY_ALIASES = {
  "서울":"서울특별시","부산":"부산광역시","대구":"대구광역시","인천":"인천광역시",
  "광주":"광주광역시","대전":"대전광역시","울산":"울산광역시","세종":"세종특별자치시"
};
const normCity = s => CITY_ALIASES[s] || s;

function parseQuery(raw) {
  const a = String(raw||'').trim();
  if (aliases[a]) return { aliasTarget: aliases[a] }; // 별칭 직행
  const parts = a.replace(/\s+/g,' ').split(' ');
  let siDo, siGunGu, dong;
  if (parts.length === 3) { siDo=normCity(parts[0]); siGunGu=parts[1]; dong=parts[2]; }
  else if (parts.length === 2) {
    if (/(구|군)$/.test(parts[0])) { siGunGu=parts[0]; dong=parts[1]; }
    else { siDo=normCity(parts[0]); dong=parts[1]; }
  } else { dong=parts[0]; }
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
      if (nxny[adminKey]) return { ok:true, match:'alias->legal->admin', legalKey, adminKey, nxny:nxny[adminKey] };
    }
  }

  const { siDo, siGunGu, dong } = parseQuery(userText);
  if (!dong) return { ok:false, reason:'NO_DONG', suggestions:[] };

  // 1) 완전 행정동 키 매칭
  if (siDo && siGunGu) {
    const adminKey = combine(`${siDo} ${siGunGu}`, dong);
    if (nxny[adminKey]) return { ok:true, match:'admin-exact', adminKey, nxny:nxny[adminKey] };
  }

  // 2) 시도만 주어진 경우
  if (siDo && !siGunGu) {
    const cities = Object.keys(idx).filter(k => k.startsWith(siDo+' '));
    for (const c of cities) {
      const legalKey = combine(c, dong);
      const as = l2a[legalKey];
      if (as && as.length) {
        const adminKey = as[0];
        if (nxny[adminKey]) return { ok:true, match:'legal->admin', legalKey, adminKey, nxny:nxny[adminKey] };
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
        if (nxny[adminKey]) return { ok:true, match:'legal->admin', legalKey, adminKey, nxny:nxny[adminKey] };
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
      if (nxny[adminKey]) {
        return { ok:true, match:'auto-corrected-gu', legalKey: candidates[0].legalKey, adminKey, nxny:nxny[adminKey] };
      }
    }
  }

  // 5) 근사 후보
  const suggestions = Object.keys(nxny)
    .filter(k => (!siDo || k.startsWith(siDo)) && k.endsWith(' '+dong))
    .slice(0, 10);
  return { ok:false, reason:'NOT_FOUND', suggestions };
}

// (호환용 default export)
export default { resolveRegion };
