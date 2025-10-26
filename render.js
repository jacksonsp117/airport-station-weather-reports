// render.js — build a LARGE, two-line SVG for an airport station using NWS API
// Usage in GH Actions: STATION=KGOK RUNWAYS="160,340" node render.js
// Node 18+/20+ has global fetch.

const fs = require("fs");

const STATION = (process.env.STATION || "KGOK").toUpperCase();
const RUNWAYS = (process.env.RUNWAYS || "").trim(); // "160,340" etc.
const OUTFILE = `${STATION.toLowerCase()}.svg`;

// ======= DISPLAY PRESETS (tune here) =======
const CANVAS_WIDTH  = 2000; // px (wide so it doesn't wrap unexpectedly)
const CANVAS_HEIGHT = 140;  // px  <<— TALLER for readability
const FONT_SIZE     = 36;   // px  <<— BIGGER text
const LINE_GAP      = 44;   // px distance between line1 and line2 baselines
const PADDING_X     = 16;   // px left/right padding
const PADDING_TOP   = 22;   // px top padding to first baseline
// ===========================================

// ---- Color helpers ----
const cTemp = (t) => (t==null) ? "#ffffff"
  : (t<=32? "#00b0ff" : t<=60? "#4fc3f7" : t<=80? "#4caf50" : t<=95? "#ffb300" : "#ff5252");
const cWind = (k) => (k<1? "#4caf50" : k<=5? "#4caf50" : k<=15? "#ffb300" : "#ff5252");
const cX = (x) => (x>=15? "#ff5252" : x>=8? "#ffb300" : "#4caf50");
const cT = (t) => (t>5? "#ff5252" : t>3? "#ffb300" : "#4caf50");

// Flight rules colors
const FLT_COLORS = { VFR:"#00e676", MVFR:"#1e88e5", IFR:"#e53935", LIFR:"#9c27b0" };

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
function ceilingFt(layers){
  if (!layers || !layers.length) return null;
  let ceil = null;
  for (const L of layers){
    let amt = (L.amount || "").toUpperCase();
    const isCeil = (amt==="BROKEN"||amt==="OVERCAST"||amt==="BKN"||amt==="OVC"||amt==="VV");
    if (isCeil){
      const baseM = (L.base && typeof L.base.value==="number") ? L.base.value : null;
      if (baseM!=null){
        const ft = baseM / 0.3048;
        if (ceil==null || ft < ceil) ceil = ft;
      }
    }
  }
  return ceil==null ? null : Math.round(ceil);
}
function flightCategory(ceilFt, visSm){
  const vis = (typeof visSm === "number") ? visSm : null;
  const ceil = (typeof ceilFt === "number") ? ceilFt : null;
  if ((ceil!=null && ceil < 500) || (vis!=null && vis < 1)) return { cat: "LIFR", color: FLT_COLORS.LIFR };
  if ((ceil!=null && ceil < 1000) || (vis!=null && vis < 3)) return { cat: "IFR",  color: FLT_COLORS.IFR  };
  if ((ceil!=null && ceil < 3000) || (vis!=null && vis < 5)) return { cat: "MVFR", color: FLT_COLORS.MVFR };
  if (ceil==null && vis==null) return { cat: "VFR", color: FLT_COLORS.VFR };
  return { cat: "VFR", color: FLT_COLORS.VFR };
}

(async function main(){
  const url = `https://api.weather.gov/stations/${STATION}/observations/latest`;
  const res = await fetch(url, { headers: { "User-Agent": `(airport-station-weather-reports/${STATION}, contact: github.com/jacksonsp117)` }});
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

  // Visibility (meters -> statute miles)
  const visM = p.visibility && typeof p.visibility.value==="number" ? p.visibility.value : null;
  const visSm = visM!=null ? (visM / 1609.34) : null;

  // Clouds / ceiling / flight category
  const cloudStr = clouds(p.cloudLayers);
  const ceilFeet = ceilingFt(p.cloudLayers);
  const { cat: fltCat, color: fltColor } = flightCategory(ceilFeet, visSm);

  // Altimeter (barometricPressure preferred; fallback seaLevelPressure)
  let baroPa = null;
  if (p.barometricPressure && typeof p.barometricPressure.value==="number") baroPa = p.barometricPressure.value;
  else if (p.seaLevelPressure && typeof p.seaLevelPressure.value==="number") baroPa = p.seaLevelPressure.value;
  const altInHg = baroPa ? (baroPa/3386.389).toFixed(2) : "";

  const ts = p.timestamp ? new Date(p.timestamp) : new Date();

  // Times: Zulu + CST/CDT
  const hh = String(ts.getUTCHours()).padStart(2,"0");
  const mm = String(ts.getUTCMinutes()).padStart(2,"0");
  const zTime = `${hh}:${mm}Z`;
  const cstOptions = { timeZone: "America/Chicago", hour12: false, hour: "2-digit", minute: "2-digit" };
  const cstTime = new Intl.DateTimeFormat("en-US", cstOptions).format(ts);

  const isCalm = (windKt < 1 || windDir==null);
  const windText = isCalm ? "Calm" : `${windDir}° ${windCard?`(${windCard}) `:""}${Math.round(windKt)} kt`;

  // Runway logic (only if RUNWAYS provided)
  let runwayText = "";
  if (!isCalm && RUNWAYS){
    const [rA, rB] = RUNWAYS.split(",").map(s=>parseInt(s.trim(),10)).filter(n=>!isNaN(n));
    if (rA && rB){
      const r1 = comps(rA, windDir, windKt);
      const r2 = comps(rB, windDir, windKt);
      const pref16 = (pickRunway(r1, r2) === "16");
      const prefNum = pref16 ? String(rA).slice(0,2) : String(rB).slice(0,2);
      const r = pref16 ? r1 : r2;
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

  // Colors for temp/wind
  const tempColor = cTemp(tempF);
  const windColor = cWind(windKt);

  // Flight rules text (with details)
  const ceilTxt = (ceilFeet!=null) ? `${Math.round(ceilFeet)} ft` : "—";
  const visTxt  = (visSm!=null)   ? `${visSm.toFixed(visSm<10 ? 1 : 0)} sm` : "—";
  const fltText = `<tspan fill="${fltColor}" font-weight="700">${fltCat}</tspan> <tspan opacity="0.85">(ceil ${ceilTxt}, vis ${visTxt})</tspan>`;

  // ===== Split into two lines for readability =====
  const partLine1 = [
    `${STATION}`,
    `${zTime} / ${cstTime} CST`,
    `<tspan fill="#81d4fa">${cloudStr}</tspan>`,
    `<tspan fill="${tempColor}">${tempF!=null? tempF : "–"}°F</tspan>`
  ].join(" • ");

  const partLine2 = [
    `<tspan fill="${windColor}">Wind ${windText}</tspan>`,
    fltText,
    `Altimeter ${altInHg? altInHg+" inHg" : "—"}`,
    runwayText
  ].filter(Boolean).join(" • ");

  // Build SVG (two text lines). Vertically position lines with PADDING_TOP and LINE_GAP.
  const line1Y = PADDING_TOP + FONT_SIZE;      // first baseline
  const line2Y = line1Y + LINE_GAP;            // second baseline

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve"
     width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}"
     viewBox="0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}">
  <rect x="0" y="0" width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}" fill="#000"/>
  <g font-family="system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif"
     font-size="${FONT_SIZE}" font-weight="600" fill="#fff">
    <text x="${PADDING_X}" y="${line1Y}">${partLine1}</text>
    <text x="${PADDING_X}" y="${line2Y}">${partLine2}</text>
  </g>
</svg>`.trim();

  fs.writeFileSync(OUTFILE, svg);
  console.log(`Wrote ${OUTFILE} (w=${CANVAS_WIDTH}, h=${CANVAS_HEIGHT}, font=${FONT_SIZE}px)`);
})();
