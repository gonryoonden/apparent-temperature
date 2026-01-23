# 개발자 확인/개선 요청 체크리스트

## 1) 개발자에게 먼저 “확인” 요청할 체크리스트

### 1-1. 업스트림(기상청)에서 무엇을 가져오는지

- `/api/pt` (실황)
  - 실제 호출하는 기상청 API 종류(초단기실황인지)와 요청하는 category 목록
  - 현재 응답에 없는 값(예: RN1 1시간 강수량 등)을 이미 가져오고 있는데 버리고 있는지 여부
- `/api/pt-forecast` (예보)
  - 단기예보 조회에서 어떤 category를 가져오는지
  - 현재 `hours[]`에 `TMP/REH/WSD/PTY/SKY`만 담는지, 아니면 `POP/PCP/SNO/TMN/TMX`도 가져오는데 미노출인지 확인

### 1-2. 시간(base_date/base_time, dt) 처리 로직

- base_time 산정 규칙이 기상청 발표시각과 일치하는지(1~2시간 밀림/빈값 이슈 원인)
- `hours[].dt` 생성/파싱이 KST 기준으로 안정적인지
- “오늘 범위”가 어디까지인지(00~23시인지, base_time 이후만인지)

### 1-3. PT 계산과 결측 처리

- PT(KMA2016) 계산이 서버에서 수행되는지(현재는 수행되는 것으로 보임)와 입력 단위 확인
- 결측값 발생 시 null 유지(추정 금지) 여부
- 예보 `hours[]`에서 특정 시간대 누락/정렬 깨짐 여부

### 1-4. 캐시/폴백(stale)와 에러 응답 일관성

- stale이 언제 true가 되는지(업스트림 실패 시 캐시 폴백 등)
- 404(지역 매칭 실패)와 500(업스트림/서버 오류)에서 모델이 처리 가능한 형태로 ok:false, note 등을 내려주는지
- `system.cache.hit/ttl`의 의미가 명확한지(초 단위 ttl 유지)

### 1-5. 지역 매칭(geocoding) 범위

- region 문자열 매칭 실패(404) 시 후보 리스트를 줄 수 있는지(현재 스키마엔 없음)
- lat/lon 입력 시 실제로 지원되는지(스키마상 지원) 및 region 우선순위

## 2) 개발자에게 “개선 요청”할 항목 (우선순위 포함)

### P0. 동절기 근거 매핑을 위한 필수 기상 요소를 응답에 추가 노출

요청

- `/api/pt-forecast`의 `hours[]`에 아래 필드 추가(가능하면 그대로 노출, 없으면 null)
  - `POP` 강수확률(%)
  - `PCP` 1시간 강수량(mm) 또는 기상청 표기값(문자열이면 그대로)
  - `SNO` 1시간 신적설(cm) 또는 기상청 표기값
- `/api/pt-forecast`의 summary 또는 신규 daily 블록에 추가
  - `TMN` 일 최저기온(℃)
  - `TMX` 일 최고기온(℃)

이유

- 현재는 PTY만 있어 “눈/비 가능성” 수준 이상으로는 근거 매핑이 제한됨.
- `PCP/SNO/TMN`이 있어야 “결빙·미끄럼, 적설 대응, 한랭 작업관리(시간대 조정)”를 값 기반으로 정교화 가능.

주의(중요)

- 기상청에서 `PCP/SNO`가 “강수없음/적설없음” 같은 문자열로 오는 경우가 있어, 서버에서 임의로 0으로 변환할지 null로 둘지 정책 결정 필요.
- “추정 금지” 원칙을 엄격히 지키려면 null 권장 + 원문 문자열 별도 보존(예: `PCP_text`)도 옵션.

### P0. “특보 발효” 단정 방지용: 현장 유의 플래그를 서버가 제공

요청

- 응답에 `hazards`(또는 `advisories`) 블록 신설(실황/예보 공통 가능)
  - `windRisk`: boolean|null (WSD/풍속이 특정 수준 이상일 때 true, 근거는 “기준 초과 가능” 수준)
  - `snowRisk`: boolean|null (PTY 2/3/6/7 or SNO>0 => true; PTY=4 is precip-only)
  - `slipFreezeRisk`: boolean|null (PT≤0 + PTY(1~7)/PCP/SNO numeric evidence)
- 단, 이름을 `advisoryIssued` 같은 “발효” 뉘앙스로 두지 말고 `risk/possible` 계열로 명명

이유

- 모델이 동절기 길잡이의 ‘특보 기준’을 “발효”로 잘못 표현하는 리스크를 기술적으로 차단.

### P1. `/api/pt-forecast`에 range 또는 from/to 지원(UX 품질)

요청 옵션

- 옵션 A: `range=6h|24h|48h|tomorrow` (기존 프롬프트 UX 유지)
- 옵션 B: `from=YYYYMMDDHHmm&to=YYYYMMDDHHmm` (가장 명확)

기대 동작

- 서버가 `hours[]`를 필터링해서 반환(모델이 자르는 것이 아니라 API가 범위를 책임)

### P1. 시간 표준화(절대시각) 추가 제공

요청

- `observedAtKst` (예: `2026-01-21T10:00+09:00`)
- `hours[].dtKst` (ISO8601) 추가 제공(기존 `dt=YYYYMMDDHHmm` 유지 가능)

### P2. 근거 메타데이터(evidence) 제공(선택, 하지만 매우 유용)

요청

- 응답에 evidence 배열 추가
  - 예: `{ "ruleId": "WINTER_5_RULES", "doc": "동절기 길잡이", "page": 5 }`
  - 예: `{ "ruleId": "WINTER_HAZARD_CHECK", "doc": "동절기 길잡이", "page": 6 }`
  - 예: `{ "ruleId": "WINTER_WIND_REF", "doc": "동절기 길잡이", "page": 11 }`

## 3) 개발 완료 판단을 위한 “수용 기준(acceptance criteria)”

- `/api/pt-forecast` 응답에 `POP/PCP/SNO`(시간대), `TMN/TMX`(일 단위)가 실제로 채워지는 케이스가 존재하고, 없으면 null로 일관됨
- “내일까지/향후 6시간” 요청 시, range/from-to로 API가 범위를 책임지고 `hours[]`를 반환
- `hazards`/`advisories` 플래그가 false/true/null로 안정적으로 내려오며, “발효” 단정 필드가 없음
- 모든 시간은 KST 절대시각(ISO8601)으로도 제공됨(모델 출력 안정)
- stale/cache/에러 응답이 일관되고, 모델이 바로 안내문을 낼 수 있음
