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
