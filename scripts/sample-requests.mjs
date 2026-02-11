// scripts/sample-requests.mjs
const API_BASE = process.env.API_BASE || "http://localhost:3000";
const DRY_RUN = String(process.env.DRY_RUN ?? "1") !== "0";

const sampleRegion = process.env.SAMPLE_REGION || "서울특별시 강남구 논현동";
const sampleLat = process.env.SAMPLE_LAT || "37.5";
const sampleLon = process.env.SAMPLE_LON || "127.0";

const urls = [
  `${API_BASE}/api/pt?region=${encodeURIComponent(sampleRegion)}&warnings=summary`,
  `${API_BASE}/api/pt-forecast?region=${encodeURIComponent(sampleRegion)}&range=24h&warnings=summary`,
  `${API_BASE}/api/warnings?region=${encodeURIComponent(sampleRegion)}`,
  `${API_BASE}/api/risk?region=${encodeURIComponent(sampleRegion)}`,
  `${API_BASE}/api/pt?lat=${encodeURIComponent(sampleLat)}&lon=${encodeURIComponent(sampleLon)}&warnings=summary`,
];

const batchBody = {
  warnings: "summary",
  regions: [
    { region: sampleRegion },
    { lat: Number(sampleLat), lon: Number(sampleLon) },
  ],
};

function printCurl() {
  console.log("# Sample requests (curl)");
  for (const u of urls) {
    console.log(`curl \"${u}\"`);
  }
  console.log(
    `curl -X POST \"${API_BASE}/api/pt-batch\" -H \"content-type: application/json\" -d '${JSON.stringify(batchBody)}'`
  );
}

async function runLive() {
  for (const u of urls) {
    const res = await fetch(u);
    const json = await res.json();
    console.log("\\nGET", u);
    console.log(JSON.stringify(json, null, 2));
  }
  const res = await fetch(`${API_BASE}/api/pt-batch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(batchBody),
  });
  const json = await res.json();
  console.log("\\nPOST", `${API_BASE}/api/pt-batch`);
  console.log(JSON.stringify(json, null, 2));
}

if (DRY_RUN) {
  printCurl();
} else {
  runLive().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

