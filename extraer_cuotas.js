// ============================================================
// EXTRACTOR DE CUOTAS — TheStatsAPI
// Trae las cuotas 1X2, over/under 2.5 goles, Y AHORA TAMBIÉN corners, tiros
// a puerta y tarjetas (línea más líquida de cada mercado, promediada entre
// casas), de los próximos partidos de las 5 ligas. Convierte todo a
// probabilidad implícita de mercado (quitando el margen de la casa), listo
// para comparar contra el modelo.
//
// USO:
//   1. Poné tu API key
//   2. node extraer_cuotas.js
//   3. Subile cuotas_mercado.json a Claude
// ============================================================

// La key ya NO se escribe acá adentro (para poder subir este archivo a
// GitHub sin exponerla). Se lee de una variable de entorno.
//   Local, PowerShell, solo esta sesión: $env:THESTATSAPI_KEY="tu_key_real"
//   Local, permanente: buscar "Variables de entorno" en Windows y agregarla ahí
//     (después hay que reabrir la terminal/VS Code para que la vea)
//   Rutina de Claude Code: configurarla en la sección "Environment" de la rutina
const API_KEY = process.env.THESTATSAPI_KEY;
const BASE    = 'https://api.thestatsapi.com/api';
const REQUEST_DELAY_MS = 3000; // mismo ritmo conservador que usamos antes

const LIGAS = [
  { key: 'premier-league', name: 'Premier League', country: 'England', searches: ['Premier League'] },
  { key: 'la-liga',        name: 'La Liga',        country: 'Spain',   searches: ['LaLiga', 'La Liga', 'Primera Division'] },
  { key: 'serie-a',        name: 'Serie A',        country: 'Italy',   searches: ['Serie A'] },
  { key: 'bundesliga',     name: 'Bundesliga',     country: 'Germany', searches: ['Bundesliga'] }, // filtra nombre exacto abajo
  { key: 'ligue-1',        name: 'Ligue 1',        country: 'France',  searches: ['Ligue 1'] },
];

// Ventana: partidos de hoy hasta 12 días adelante (igual que el modo lote del modelo)
const WINDOW_DAYS = 12;

const HEADERS = { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };
const sleep   = ms => new Promise(r => setTimeout(r, ms));
const ts      = () => new Date().toLocaleTimeString();

let lastCall = 0;
async function throttle(){
  const wait = REQUEST_DELAY_MS - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
}
async function apiRaw(path) {
  await throttle();
  const res = await fetch(`${BASE}${path}`, { headers: HEADERS });
  if (res.status === 429) return { rateLimited: true };
  if (!res.ok) { const txt = await res.text(); throw new Error(`${res.status} ${path}\n${txt}`); }
  return { data: await res.json() };
}
async function api(path) {
  let r = await apiRaw(path);
  if (r.rateLimited) {
    console.log(`   [${ts()}] ⏳ 429, reintento en 25s...`);
    await sleep(25000);
    r = await apiRaw(path);
    if (r.rateLimited) throw new Error(`Rate limit persistente: ${path}`);
  }
  return r.data;
}
async function fetchAll(path, perPage = 100) {
  const items = []; let page = 1;
  while (true) {
    const sep = path.includes('?') ? '&' : '?';
    const data = await api(`${path}${sep}per_page=${perPage}&page=${page}`);
    const chunk = data.data || [];
    items.push(...chunk);
    if (items.length >= (data.meta?.total ?? chunk.length)) break;
    if (chunk.length < perPage) break;
    page++;
  }
  return items;
}

async function findLeague(liga) {
  console.log(`\n[${ts()}] 🔍 Buscando ${liga.name}...`);
  for (const term of liga.searches) {
    const comps = await fetchAll(`/football/competitions?search=${encodeURIComponent(term)}&country=${encodeURIComponent(liga.country)}&type=league`);
    // Para Bundesliga: descartar "2. Bundesliga" / "3. Liga" explícitamente (mismo bug que la vez pasada)
    let comp = comps.find(c => c.name === liga.name || c.name.toLowerCase() === liga.name.toLowerCase());
    if (!comp) comp = comps.find(c => !/^(2\.|3\.)/.test(c.name));
    if (comp) {
      console.log(`   comp_id=${comp.id} | odds=${comp.odds_available}`);
      const seasons = await api(`/football/competitions/${comp.id}/seasons`);
      const sCurr = (seasons.data || []).find(s => s.is_current);
      if (sCurr) {
        console.log(`   season_id=${sCurr.id} (${sCurr.name})`);
        return { comp_id: comp.id, season_id: sCurr.id, odds_available: comp.odds_available };
      }
    }
  }
  throw new Error(`No encontré ${liga.name}`);
}

// Decimal (ej. "1.810") -> probabilidad implícita = 1/decimal
function impliedProb(decimalStr){
  const d = parseFloat(decimalStr);
  return (d && d > 0) ? 1/d : null;
}

// Quita el margen de la casa (overround): normaliza para que las 3
// probabilidades sumen exactamente 1. Esto es lo que hay que comparar
// contra el modelo, no la probabilidad implícita cruda (que siempre
// suma >100% porque ahí está la ganancia de la casa).
function devigProbs(pH, pD, pA){
  const s = pH + pD + pA;
  if (!s) return null;
  return { home: pH/s, draw: pD/s, away: pA/s, overround: s };
}

async function procesarLiga(liga, resultado) {
  const { comp_id, season_id, odds_available } = await findLeague(liga);
  if (!odds_available) {
    console.log(`   ⚠️ Esta competencia no tiene cuotas disponibles en tu plan.`);
    return;
  }

  const hoy = new Date();
  const limite = new Date(hoy); limite.setDate(limite.getDate() + WINDOW_DAYS);

  console.log(`   Descargando partidos próximos (${WINDOW_DAYS} días)...`);
  const partidos = await fetchAll(`/football/matches?competition_id=${comp_id}&season_id=${season_id}&status=scheduled`);
  const proximos = partidos.filter(m => {
    const d = new Date(m.utc_date);
    return d >= hoy && d <= limite;
  });
  console.log(`   ${proximos.length} partidos en la ventana`);

  let conCuota = 0, sinCuota = 0;
  for (const m of proximos) {
    let odds = null;
    try {
      const r = await api(`/football/matches/${m.id}/odds`);
      odds = r.data;
    } catch(e) { sinCuota++; continue; }

    // Promediamos entre las casas disponibles para ese partido (más robusto
    // que quedarse con una sola, y evita depender de que Bet365 siempre esté)
    const books = (odds?.bookmakers || []).filter(b => b.markets?.match_odds);
    if (books.length === 0) { sinCuota++; continue; }

    let sumH=0, sumD=0, sumA=0, sumOver=0, sumUnder=0, nGoals=0, n=0;
    // Para corners/tiros/tarjetas: no hay una línea estándar fija como 2.5 en
    // goles, cada casa puede ofrecer líneas distintas (9.5, 10.5, etc). Se
    // junta TODO lo que aparece, se promedia por línea entre las casas que
    // coinciden en esa línea, y se usa la línea con más casas de acuerdo
    // (más líquida = más confiable) como referencia principal.
    const linePools = { corners: {}, cards: {}, sot: {} };
    function accumulateLine(pool, marketObj){
      if (!marketObj) return;
      for (const line in marketObj) {
        const ou = marketObj[line];
        const pOver = impliedProb(ou.over?.last_seen ?? ou.over?.opening);
        const pUnder = impliedProb(ou.under?.last_seen ?? ou.under?.opening);
        if (!pOver || !pUnder) continue;
        if (!pool[line]) pool[line] = { sumOver:0, sumUnder:0, n:0 };
        pool[line].sumOver += pOver; pool[line].sumUnder += pUnder; pool[line].n++;
      }
    }

    for (const b of books) {
      const mo = b.markets.match_odds;
      const pH = impliedProb(mo.home?.last_seen ?? mo.home?.opening);
      const pD = impliedProb(mo.draw?.last_seen ?? mo.draw?.opening);
      const pA = impliedProb(mo.away?.last_seen ?? mo.away?.opening);
      if (pH && pD && pA) { sumH+=pH; sumD+=pD; sumA+=pA; n++; }

      const tg = b.markets.total_goals?.['2.5'];
      if (tg?.over && tg?.under) {
        const pOver = impliedProb(tg.over.last_seen ?? tg.over.opening);
        const pUnder = impliedProb(tg.under.last_seen ?? tg.under.opening);
        if (pOver && pUnder) { sumOver+=pOver; sumUnder+=pUnder; nGoals++; }
      }

      accumulateLine(linePools.corners, b.markets.match_corners);
      accumulateLine(linePools.cards, b.markets.total_cards);
      accumulateLine(linePools.sot, b.markets.match_shots_on_target);
    }
    if (n === 0) { sinCuota++; continue; }

    // De cada pool, elegir la línea con más casas de acuerdo (más líquida)
    function bestLine(pool){
      const lines = Object.keys(pool);
      if (lines.length === 0) return null;
      const best = lines.reduce((a,b) => pool[a].n >= pool[b].n ? a : b);
      const p = pool[best];
      const dv = devigProbs(p.sumOver/p.n, p.sumUnder/p.n, 0); // devig como si fueran 2 outcomes
      return { line: parseFloat(best), over: +dv.home.toFixed(4), under: +dv.draw.toFixed(4), bookmakers: p.n };
    }
    const cornersLine = bestLine(linePools.corners);
    const cardsLine = bestLine(linePools.cards);
    const sotLine = bestLine(linePools.sot);

    const devig = devigProbs(sumH/n, sumD/n, sumA/n);
    const devigGoals = nGoals>0 ? devigProbs(sumOver/nGoals, sumUnder/nGoals, 0) : null;

    resultado[liga.key] = resultado[liga.key] || {};
    resultado[liga.key][`${m.home_team.name}||${m.away_team.name}`] = {
      date: m.utc_date,
      bookmakers_count: n,
      market: { home: +devig.home.toFixed(4), draw: +devig.draw.toFixed(4), away: +devig.away.toFixed(4) },
      overround_pct: +((devig.overround-1)*100).toFixed(2),
      over25: devigGoals ? +devigGoals.home.toFixed(4) : null,
      under25: devigGoals ? +devigGoals.draw.toFixed(4) : null,
      corners: cornersLine, // {line, over, under, bookmakers} o null
      cards: cardsLine,
      sot: sotLine,
    };
    conCuota++;
    await sleep(200);
  }
  console.log(`   ✅ ${conCuota} con cuota, ${sinCuota} sin cuota disponible`);
}

async function main() {
  if (!API_KEY) { console.error('❌ Falta la variable de entorno THESTATSAPI_KEY (ver el comentario arriba de la declaración de API_KEY).'); process.exit(1); }
  const fs = require('fs');
  const resultado = {};

  for (const liga of LIGAS) {
    try {
      await procesarLiga(liga, resultado);
    } catch(e) {
      console.error(`❌ Error en ${liga.name}:`, e.message);
    }
    fs.writeFileSync('cuotas_mercado.json', JSON.stringify({ extracted_at: new Date().toISOString(), leagues: resultado }, null, 2));
  }

  console.log('\n════════════════════════════════');
  console.log('✅ cuotas_mercado.json guardado');
  console.log('📎 Subile ese archivo a Claude');
  console.log('════════════════════════════════');
}
main().catch(e => { console.error('Error fatal:', e); process.exit(1); });
