export function computeRisk({ apparentTemperature, hazards = {}, warnings = {} } = {}) {
  let score = 0;

  const pt = Number.isFinite(apparentTemperature) ? apparentTemperature : null;
  if (pt != null) {
    if (pt >= 38) score += 70;
    else if (pt >= 33) score += 50;
    else if (pt >= 31) score += 30;

    if (pt <= -10) score += 60;
    else if (pt <= -5) score += 40;
    else if (pt <= -1) score += 20;
  }

  const level = warnings?.highestLevel || null;
  if (level === "경보") score += 30;
  else if (level === "주의보") score += 20;

  if (hazards?.windRisk === true) score += 10;
  if (hazards?.snowRisk === true) score += 10;
  if (hazards?.slipFreezeRisk === true) score += 10;

  if (score > 100) score = 100;
  let band = "Low";
  if (score >= 80) band = "Critical";
  else if (score >= 60) band = "High";
  else if (score >= 40) band = "Medium";

  return {
    score,
    level: band,
  };
}

