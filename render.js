// render.js — build a live SVG for an airport station using NWS API
// Usage in GH Actions: STATION=KGOK RUNWAYS="160,340" node render.js
// Node 18+/20+ has global fetch.

const fs = require("fs");

const STATION = (process.env.STATION || "KGOK").toUpperCase();
const RUNWAYS = (process.env.RUNWAYS || "").trim(); // e.g., "160,340"
const OUTFILE = `${STATION.toLowerCase()}.svg`;

// ---- Color helpers ----
const cTemp = (t) => (t==null) ? "#ffffff"
  : (t<=32? "#00b0ff" : t<=60? "#4fc3f7" : t<=80? "#4caf50" : t<=95? "#ffb300" : "#ff5252");
const cWind = (k) => (k<1? "#4caf50" : k<=5? "#4caf50" : k<=15? "#ffb300" : "#ff5252");
const cX = (x) => (x>=15? "#ff5252" : x>=8? "#ffb300" : "#4caf50");
const cT = (t) => (t>5? "#ff5252" : t>3? "#ffb300" : "#4caf50");

// Flight rules colors (standard convention)
const FLT_COLORS = {
  VFR:  "#00e676", // green
  MVFR: "#1e88e5", // blue
  IFR:  "#e53935", // red
  LIFR: "#9c27b0"  // magenta
};

// ---- Wind + runway math ----
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

// ---- Clouds / Ceiling / Flight Category ----
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
    const base = (L.base && typeof L.base.value==="number") ? Math.round(L.base.value/0.3048/100) : null; // hundreds ft
    out.push(amt + (base? String(base).padStart(3,"0") : "///"));
  }
  return out.join(" ");
}

// Determine ceiling (ft AGL) from lowest BKN/OVC layer; returns null if none
function ceilingFt(layers){
  if (!layers || !layers.length) return null;
  let ceil = null;
  for (const L of layers){
    let amt = (L.amount || "").toUpperCase();
    if (amt==="BROKEN" || amt==="OVERCAST" || amt==="BKN" || amt==="OVC"){
      const baseM = (L.base && typeof L.base.value==="number") ? L.base.value : null;
      if (baseM!=null){
        const ft = baseM / 0.3048;
        if (ceil==null || ft < ceil) ceil = ft;
      }
    }
    // If NWS ever sends vertical visibility (VV), treat like an overcast ceiling:
    if (amt==="VV"){
      const baseM = (L.base && typeof L.base.value==="number") ? L.base.value : null;
      if (baseM!=null){
        const ft = baseM / 0.3048;
        if (ceil==null || ft < ceil) ceil = ft;
      }
    }
  }
  return ceil==null ? null : Math.round(ceil);
}

// Compute FAA flight category: LIFR / IFR / MVFR / VFR
// Rules:
//   LIFR: ceil < 500 ft OR vis < 1 sm
//   IFR:  ceil 500–<1000 OR vis 1–<3 sm
//   MVFR: ceil 1000–<3000 OR vis 3–<5 sm
//   VFR:  ceil >=3000 AND vis >=5 sm
function flightCategory(ceilFt, visSm){
  // If one is missing, base on the other if available
  const vis = (typeof visSm === "number") ? visSm : null;
  const ceil = (typeof ceilFt === "number") ? ceilFt : null;

  if ((ceil!=null && ceil < 500) || (vis!=null && vis < 1)) return { cat: "LIFR", color: FLT_COLORS.LIFR };
  if ((ceil!=null && ceil < 1000) || (vis!=null && vis < 3)) return { cat: "IFR",  color: FLT_COLORS.IFR  };
  if ((ceil!=null && ceil < 3000) || (vis!=null && vis < 5)) return { cat: "MVFR", color: FLT_COLORS.MVFR };
  if (ceil==null && vis==null) return { cat: "VFR", color: FLT_COLORS.VFR }; // assume best if nothing reported
  return { cat: "VFR", color: FLT_COLORS.VFR };
}

(async function main(){
  const url = `https://api.weather.gov/stations/${STATION}/observations/latest`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": `(airport-station-weather-reports/${STATION}, contact: github.com/jacksonsp117)`
    }
  });
  const j = await res.json();
  const p = j && j.properties ? j.properties : {};

  // Core weather data
  const tempC = p.temperature && typeof p.temperature.value==="number" ? p.temperature.value : null;
  const tempF = tempC!=null ? Math.round((tempC*9/5)+32) : null;

  const ws_mps = p.windSpeed && typeof p.windSpeed.value==="number" ? p.windSpeed.value : 0;
  const windKt = ws_mps * 1.94384;

  const wd_raw = p.windDirection && typeof p.windDirection.value==="number" ? p.windDirection.value : null;
  const windDir = wd_raw!=null ? Math.round(wd_raw) : null;
  const windCard = windDir!=null ? toCardinal(windDir) : "";

  // Visibility in statute miles (if reported)
  // NWS visibility is meters; convert: 1 sm = 1609.34 m
  const visM = p.visibility && typeof p.visibility.value==="number" ? p.visibility.value : null;
  const visSm = visM!=null ? (visM / 1609.34) : null;

  // Clouds and ceiling
  const cloudStr = clouds(p.cloudLayers);
  const ceilFeet = ceilingFt(p.cloudLayers);

  // Flight category
  const { cat: fltCat, color: fltColor } = flightCategory(ceilFeet, visSm);

  // Altimeter (barometricPressure preferred; fallback to seaLevelPressure)
  let baroPa = null;
  if (p.barometricPressure && typeof p.barometricPressure.value==="number") baroPa = p.barometricPressure.value;
  else if (p.seaLevelPressure && typeof p.seaLevelPressure.value==="number") baroPa = p.seaLevelPressure.value;
  const altInHg = baroPa ? (baroPa/3386.389).toFixed(2) : "";

  const ts = p.timestamp ? new Date(p.timestamp) : new Date();

  // --- Zulu and CST time ---
  const hh = String(ts.getUTCHours()).padStart(2,"0");
  const mm = String(ts.getUTCMinutes()).padStart(2,"0");
  const zTime = `${hh}:${mm}Z`;

  const cstOptions = { timeZone: "America/Chicago", hour12: false, hour: "2-digit", minute: "2-digit" };
  const cstTime = new Intl.DateTimeFormat("en-US", cstOptions).format(ts);

  const isCalm = (windKt < 1 || windDir==null);
  const windText = isCalm ? "Calm" : `${windDir}° ${windCard?`(${windCard}) `:""}${Math.round(windKt)} kt`;

  // Runway logic
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

  // Colors
  const tempColor = cTemp(tempF);
  const windColor = cWind(windKt);

  // Flight rules details text (ceil/vis)
  const ceilTxt = (ceilFeet!=null) ? `${Math.round(ceilFeet)} ft` : "—";
  const visTxt = (visSm!=null) ? `${visSm.toFixed(visSm<10 ? 1 : 0)} sm` : "—";
  const fltText = `<tspan fill="${fltColor}" font-weight="700">${fltCat}</tspan> <tspan opacity="0.85">(ceil ${ceilTxt}, vis ${visTxt})</tspan>`;

  // ---- Assemble the text line ----
  const parts = [
    `${STATION} • ${zTime} / ${cstTime} CST`,
    `<tspan fill="#81d4fa">${cloudStr}</tspan>`,
    `<tspan fill="${tempColor}">${tempF!=null? tempF : "–"}°F</tspan>`,
    `<tspan fill="${windColor}">Wind ${windText}</tspan>`,
    fltText,
    `Altimeter ${altInHg? altInHg+" inHg" : "—"}`,
    runwayText
  ].filter(Boolean);

  // ---- SVG output ----
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="80" viewBox="0 0 1200 60">
  <rect x="0" y="0" width="1200" height="80" fill="#000"/>
  <g font-family="system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif" font-size="24" font-weight="600">
    <text x="12" y="38" fill="#fff">
      ${parts.join(' • ')}
    </text>
  </g>
</svg>`.trim();

  fs.writeFileSync(OUTFILE, svg);
  console.log(`Wrote ${OUTFILE}`);
})();
