// render.js — build a live SVG for an airport station using NWS API
// Usage in GH Actions: STATION=KGOK RUNWAYS="160,340" node render.js
// If RUNWAYS is omitted, runway recommendation is hidden (useful for other fields).
// Node 18+/20+ has global fetch.

const fs = require("fs");

const STATION = (process.env.STATION || "KGOK").toUpperCase();
const RUNWAYS = (process.env.RUNWAYS || "").trim(); // e.g., "160,340"
const OUTFILE = `${STATION.toLowerCase()}.svg`;

// color helpers (same palette you liked)
const cTemp = (t) => (t==null) ? "#ffffff"
  : (t<=32? "#00b0ff" : t<=60? "#4fc3f7" : t<=80? "#4caf50" : t<=95? "#ffb300" : "#ff5252");
const cWind = (k) => (k<1? "#4caf50" : k<=5? "#4caf50" : k<=15? "#ffb300" : "#ff5252");
const cX = (x) => (x>=15? "#ff5252" : x>=8? "#ffb300" : "#4caf50");
const cT = (t) => (t>5? "#ff5252" : t>3? "#ffb300" : "#4caf50");

function toCardinal(deg){
  if (deg==null || isNaN(deg)) return "";
  const d=["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW","N"];
  return d[Math.round(deg/22.5)];
}
const norm = (a)=> ((a%360)+360)%360;
function comps(rwy,dir,spd){
  if (dir==null || isNaN(dir) || !spd) return {h:0,x:0};
  let rel=norm(dir-rwy); if (rel>180) rel-=360; if (rel<-180) rel+=360;
  const rad = rel*Math.PI/180;
  return { h: spd*Math.cos(rad), x: Math.abs(spd*Math.sin(rad)) };
}
function pickRunway(r16,r34){
  if (Math.abs(r16.h - r34.h) > 2) return r16.h > r34.h ? "16" : "34";
  return r16.x <= r34.x ? "16" : "34";
}
function clouds(layers){
  if (!layers || !layers.length) return "SKC";
  const out=[];
  for (const L of layers){
    let amt = (L.amount||"").toUpperCase();
    if (amt==="SCATTERED") amt="SCT";
    if (amt==="BROKEN")    amt="BKN";
    if (amt==="OVERCAST")  amt="OVC";
    if (amt==="FEW")       amt="FEW";
    if (amt==="CLEAR")     amt="CLR";
    amt = amt.slice(0,3);
    const base = (L.base && typeof L.base.value==="number") ? Math.round(L.base.value/0.3048/100) : null;
    out.push(amt + (base? String(base).padStart(3,"0") : "///"));
  }
  return out.join(" ");
}

(async function main(){
  const url = `https://api.weather.gov/stations/${STATION}/observations/latest`;
  const res = await fetch(url, {
    headers: {
      // NWS requires a unique User-Agent with contact info
      "User-Agent": `(airport-station-weather-reports/${STATION}, contact: github.com/jacksonsp117)`
    }
  });
  const j = await res.json();
  const p = j && j.properties ? j.properties : {};

  // core values
  const tempC = p.temperature && typeof p.temperature.value==="number" ? p.temperature.value : null;
  const tempF = tempC!=null ? Math.round((tempC*9/5)+32) : null;

  const ws_mps = p.windSpeed && typeof p.windSpeed.value==="number" ? p.windSpeed.value : 0;
  const windKt = ws_mps * 1.94384;

  const wd_raw = p.windDirection && typeof p.windDirection.value==="number" ? p.windDirection.value : null;
  const windDir = wd_raw!=null ? Math.round(wd_raw) : null;
  const windCard = windDir!=null ? toCardinal(windDir) : "";

  const cloudStr = clouds(p.cloudLayers);

  let baroPa = null;
  if (p.barometricPressure && typeof p.barometricPressure.value==="number") baroPa = p.barometricPressure.value;
  else if (p.seaLevelPressure && typeof p.seaLevelPressure.value==="number") baroPa = p.seaLevelPressure.value;
  const altInHg = baroPa ? (baroPa/3386.389).toFixed(2) : "";

  const ts = p.timestamp ? new Date(p.timestamp) : new Date();
  const hh = String(ts.getUTCHours()).padStart(2,"0");
  const mm = String(ts.getUTCMinutes()).padStart(2,"0");
  const zTime = `${hh}:${mm}Z`; // always Zulu for universal clarity

  const desc = p.textDescription || "N/A";
  const isCalm = (windKt < 1 || windDir==null);
  const windText = isCalm ? "Calm" : `${windDir}° ${windCard?`(${windCard}) `:""}${Math.round(windKt)} kt`;

  // runway logic if RUNWAYS provided (e.g., "160,340")
  let runwayText = "";
  if (!isCalm && RUNWAYS){
    const [rA, rB] = RUNWAYS.split(",").map(s=>parseInt(s.trim(),10)).filter(n=>!isNaN(n));
    if (rA && rB){
      const r1 = comps(rA, windDir, windKt);
      const r2 = comps(rB, windDir, windKt);
      const prefNum = pickRunway(r1, r2) === String(rA).slice(0,2) ? String(rA).slice(0,2) : String(rB).slice(0,2);
      const r = prefNum===String(rA).slice(0,2) ? r1 : r2;
      const tail = r.h<0 ? Math.round(Math.abs(r.h)) : 0;
      const xColor = cX(r.x);
      const tColor = cT(tail);
      runwayText =
        `<tspan fill="${xColor}" font-weight="700">Preferred: RWY ${prefNum}</tspan>`+
        ` <tspan opacity="0.85">(${tail? `<tspan fill='${tColor}'>TW ${tail} kt</tspan>` : `HW ${Math.round(Math.max(0,r.h))} kt`}, XW ${Math.round(r.x)} kt)</tspan>`;
    }
  } else if (isCalm) {
    runwayText = `<tspan fill="#4caf50" font-weight="700">Preferred: Either (calm)</tspan>`;
  }

  // colors
  const tempColor = cTemp(tempF);
  const windColor = cWind(windKt);

  // Compose a single-line text (SVG)
  const parts = [
    `${STATION} • ${zTime}`,
    `<tspan fill="#81d4fa">${cloudStr}</tspan>`,
    `<tspan fill="${tempColor}">${tempF!=null? tempF : "–"}°F</tspan>`,
    `<tspan fill="${windColor}">Wind ${windText}</tspan>`,
    `Altimeter ${altInHg? altInHg+" inHg" : "—"}`,
    runwayText
  ].filter(Boolean);

  // Measure? We’ll just use a wide viewBox to be safe
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="80" viewBox="0 0 1200 42">
  <rect x="0" y="0" width="1200" height="42" fill="#000"/>
  <g font-family="system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif" font-size="14" font-weight="600">
    <text x="12" y="26" fill="#fff">
      ${parts.join(' • ')}
    </text>
  </g>
</svg>`.trim();

  fs.writeFileSync(OUTFILE, svg);
  console.log(`Wrote ${OUTFILE}`);
})();

