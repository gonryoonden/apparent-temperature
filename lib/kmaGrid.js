// lib/kmaGrid.js - KMA DFS 좌표변환
const RE=6371.00877, GRID=5.0, SLAT1=30.0, SLAT2=60.0, OLON=126.0, OLAT=38.0, XO=43, YO=136;
const DEGRAD = Math.PI/180.0, RADDEG = 180.0/Math.PI;
const re = RE/GRID;
const slat1 = SLAT1*DEGRAD, slat2 = SLAT2*DEGRAD, olon = OLON*DEGRAD, olat = OLAT*DEGRAD;
const sn = Math.log(Math.cos(slat1)/Math.cos(slat2))/Math.log(Math.tan(Math.PI*0.25+slat2*0.5)/Math.tan(Math.PI*0.25+slat1*0.5));
const sf = Math.pow(Math.tan(Math.PI*0.25+slat1*0.5), sn)*Math.cos(slat1)/sn;
const ro = re*sf/Math.pow(Math.tan(Math.PI*0.25+olat*0.5), sn);

function latlonToGrid(lat, lon){
  const ra = re*sf/Math.pow(Math.tan(Math.PI*0.25+(lat)*DEGRAD*0.5), sn);
  let theta = lon*DEGRAD - olon; if (theta > Math.PI) theta -= 2.0*Math.PI; if (theta < -Math.PI) theta += 2.0*Math.PI;
  theta *= sn;
  return {
    nx: Math.floor(ra*Math.sin(theta) + XO + 0.5),
    ny: Math.floor(ro - ra*Math.cos(theta) + YO + 0.5),
  };
}
module.exports = { latlonToGrid };
