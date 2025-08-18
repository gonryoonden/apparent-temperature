function wetBulbStull(Ta, RH){
  const atan = Math.atan;
  return Ta*atan(0.151977*Math.sqrt(RH+8.313659))
       + atan(Ta+RH) - atan(RH-1.676331)
       + 0.00391838*Math.pow(RH,1.5)*atan(0.023101*RH) - 4.686035;
}
function perceivedTemp(Ta, RH){
  const Tw = wetBulbStull(Ta, RH);
  return -0.2442 + 0.55399*Tw + 0.45535*Ta - 0.0022*Tw*Tw + 0.00278*Tw*Ta + 3.0;
}
function levelByPT(pt){
  if (pt >= 40) return "위험";
  if (pt >= 38) return "경고";
  if (pt >= 35) return "주의";
  if (pt >= 32) return "관심";
  return null;
}
export { perceivedTemp, levelByPT };
