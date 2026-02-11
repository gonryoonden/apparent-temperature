# KMA Perceived Temperature API (Vercel)
- 기상청 단기예보 TMP/REH로 체감온도(PT) 계산.
- Vercel 환경변수에 **KMA_SERVICE_KEY**(원문 키) 등록 후 배포.
- 테스트:
  - `/api/pt?place=대전&startHour=9&endHour=13&mode=phrase`
## Quick Start
1) `.env` 생성 (`.env.example` 참조)  
2) 행정구역 맵 생성:
   ```bash
   npm run build -- --mix="data/KIKmix.20250701.xlsx"
   ```

로컬 실행: vercel dev 또는 npm start

## Sanity Test
```bash
node -e "const {resolveRegion}=require('./lib/region-resolver'); console.log(resolveRegion('대전 와동'))"
node scripts/test-pt-accuracy.mjs
```

## New APIs
- GET `/api/warnings?region=서울특별시 강남구 논현동`
- GET `/api/warnings?lat=37.5&lon=127.0&detail=true`
- GET `/api/pt?region=서울특별시 강남구 논현동&warnings=summary`
- GET `/api/pt-forecast?region=서울특별시 강남구 논현동&warnings=full`
- GET `/api/risk?region=서울특별시 강남구 논현동`
- POST `/api/pt-batch`

### Batch example
```bash
curl -X POST http://localhost:3000/api/pt-batch \
  -H "content-type: application/json" \
  -d '{"warnings":"summary","regions":[{"region":"서울특별시 강남구 논현동"},{"lat":37.5,"lon":127.0}],"concurrency":4,"timeoutMs":8000}'
```

### Sample requests script
```bash
node scripts/sample-requests.mjs
DRY_RUN=0 API_BASE=http://localhost:3000 node scripts/sample-requests.mjs
```

## 운영 플로우 (특보 매핑 데이터)
- `data/warnings_*.json`을 **레포에 커밋**해서 운영에서 그대로 사용
- 데이터 갱신 필요 시: 로컬/CI에서 xlsx로 JSON 재생성 후 커밋
- 배포 빌드 시 xlsx가 없으면 기존 JSON을 그대로 사용하도록 fallback 동작
