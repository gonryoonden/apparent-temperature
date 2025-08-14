const { perceivedTemp, levelByPT } = require('../lib/pt');
const { latlonToGrid } = require('../lib/kmaGrid');

const CITY_PRESET = {
  "대전": { lat: 36.3504, lon: 127.3845 },
  "daejeon": { lat: 36.3504, lon: 127.3845 }
};
const BASE_HOURS = [2,5,8,11,14,17,20,23];

function chooseBase(dateISO, startHour){
  const h = Number(startHour);
  let baseHour = BASE_HOURS.slice().reverse().find(b => b <= h) ?? 23;
  let d = new Date(dateISO + "T00:00:00+09:00");
  if (h < 2) d.setDate(d.getDate()-1);
  const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), day=String(d.getDate()).padStart(2,'0');
  return { base_date: `${y}${m}${day}`, base_time: String(baseHour).padStart(2,'0')+"00" };
}
const parseHour = h => String(h).padStart(2,'0')+"00";

module.exports = async (req, res) => {
  try {
    const { place="대전", date, startHour="9", endHour="13", mode, threshold } = req.query;
    const targetDate = (date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }));
    const startH = Number(startHour), endH = Number(endHour);

    // 1. API 키
    const serviceKey = process.env.KMA_SERVICE_KEY;
    if (!serviceKey) {
      return res.status(500).json({ error: "KMA_SERVICE_KEY environment variable is not set" });
    }

    // 2. 위치→격자
    let lat, lon;
    if (place.includes(",")) [lat,lon] = place.split(",").map(Number);
    else if (CITY_PRESET[place?.toLowerCase?.()] || CITY_PRESET[place]) {
      const p = CITY_PRESET[place?.toLowerCase?.()] || CITY_PRESET[place];
      lat=p.lat; lon=p.lon;
    } else { ({lat,lon} = CITY_PRESET["대전"]); }
    const { nx, ny } = latlonToGrid(lat, lon);

    // 3. 기상청 API 호출 URL 생성(이중 인코딩 금지)
    const { base_date, base_time } = chooseBase(targetDate, startH);
    const qs = new URLSearchParams({
      pageNo: "1",
      numOfRows: "2000",
      dataType: "JSON",
      base_date,
      base_time,
      nx: String(nx),
      ny: String(ny)
    }).toString();
    const url = `https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst?serviceKey=${serviceKey}&${qs}`;

    // 4. fetch
    const r = await fetch(url);
    if (!r.ok) {
      const text = await r.text();
      return res.status(500).json({ 
        error: `KMA API HTTP error: ${r.status} ${r.statusText}`,
        responsePreview: text.substring(0, 400),
        url: url.replace(serviceKey, "***HIDDEN***")
      });
    }
    const responseText = await r.text();

    // 5. 응답이 JSON이 아닐 수도 있으니 미리 확인
    let json;
    try {
      json = JSON.parse(responseText);
    } catch (parseError) {
      // KMA에서 XML 등으로 에러 메시지 줄 경우
      return res.status(500).json({ 
        error: "Invalid JSON response from KMA API",
        responsePreview: responseText.substring(0, 500),
        url: url.replace(serviceKey, "***HIDDEN***")
      });
    }

    // 6. API 응답 구조 및 에러 코드 확인
    if (!json.response) {
      return res.status(500).json({ 
        error: "Unexpected response structure from KMA API",
        response: json,
        url: url.replace(serviceKey, "***HIDDEN***")
      });
    }
    const header = json.response.header;
    if (header.resultCode !== "00") {
      return res.status(500).json({ 
        error: `KMA API error: ${header.resultCode} - ${header.resultMsg}`,
        header: header,
        url: url.replace(serviceKey, "***HIDDEN***")
      });
    }

    const items = json?.response?.body?.items?.item || [];

    // 7. 시간대 필터링 및 TMP/REH 추출
    const wantDate = targetDate.replaceAll("-","");
    const hoursWanted = new Set(Array.from({length:(endH-startH+1)}, (_,i)=>parseHour(startH+i)));
    const rowsMap = {};
    for (const it of items){
      if (it.fcstDate !== wantDate) continue;
      if (!hoursWanted.has(it.fcstTime)) continue;
      if (!rowsMap[it.fcstTime]) rowsMap[it.fcstTime] = {};
      if (it.category === "TMP") rowsMap[it.fcstTime].Ta = parseFloat(it.fcstValue);
      if (it.category === "REH") rowsMap[it.fcstTime].RH = parseFloat(it.fcstValue);
    }

    // 8. 체감온도 계산
    const th = threshold ? Number(threshold) : null;
    const times = Array.from(hoursWanted).sort();
    const rows = [];
    for (const t of times){
      const rec = rowsMap[t] || {};
      if (typeof rec.Ta === "number" && typeof rec.RH === "number"){
        const PT = Math.round(perceivedTemp(rec.Ta, rec.RH)*10)/10;
        const lvl = th ? (PT >= th ? "임계초과" : null) : levelByPT(PT);
        rows.push({ time: t.slice(0,2)+":00", Ta: rec.Ta, RH: rec.RH, PT, alert: lvl });
      } else {
        rows.push({ time: t.slice(0,2)+":00", Ta: null, RH: null, PT: null, alert: null });
      }
    }

    // 9. phrase 모드(문장) 지원
    if (mode === "phrase"){
      const lines = rows.map(r=>{
        if (r.PT==null) return `${r.time} 자료가 부족합니다.`;
        return `${r.time} ${place}의 온도는 ${r.Ta}℃, 습도 ${r.RH}%로 체감온도는 ${r.PT}℃입니다${r.alert?` [${r.alert}]`:``}.`;
      });
      return res.status(200).json({ 
        place, 
        date: targetDate, 
        nx, 
        ny, 
        base_date, 
        base_time, 
        lines
      });
    }
    
    // 10. JSON 기본 응답
    res.status(200).json({ 
      place, 
      date: targetDate, 
      nx, 
      ny, 
      base_date, 
      base_time, 
      rows
    });
  } catch (e){
    res.status(500).json({ error: String(e), stack: e.stack });
  }
};
