// ============================================================
// EXTRACTOR DE RESULTADOS REALES — TheStatsAPI
// Trae partidos ya jugados de los últimos N días, con marcador y
// totales de corners/tiros a puerta/tarjetas, en el formato exacto
// que necesita resultsDB del artifact.
//
// Cadencia sugerida: una vez por semana alcanza (un resultado ya
// jugado no cambia). No hace falta correr esto tan seguido como
// extraer_cuotas.js.
//
// USO:
//   1. Poné tu API key
//   2. node extraer_resultados.js
//   3. Verificá nombres de equipo contra LEAGUES[liga].teams antes
//      de pegar en resultsDB (o dejá que Claude Code lo haga, según
//      CLAUDE.md)
// ============================================================

// La key ya NO se escribe acá adentro (para poder subir este archivo a
// GitHub sin exponerla). Se lee de una variable de entorno.
//   Local, PowerShell, solo esta sesión: $env:THESTATSAPI_KEY="tu_key_real"
//   Local, permanente: buscar "Variables de entorno" en Windows y agregarla ahí
//     (después hay que reabrir la terminal/VS Code para que la vea)
//   Rutina de Claude Code: configurarla en la sección "Environment" de la rutina
const API_KEY = process.env.THESTATSAPI_KEY;
const BASE    = 'https://api.thestatsapi.com/api';
const REQUEST_DELAY_MS = 3000;

const LIGAS = [
  { key: 'premier-league', name: 'Premier League', country: 'England', searches: ['Premier League'] },
  { key: 'la-liga',        name: 'La Liga',        country: 'Spain',   searches: ['LaLiga', 'La Liga', 'Primera Division'] },
  { key: 'serie-a',        name: 'Serie A',        country: 'Italy',   searches: ['Serie A'] },
  { key: 'bundesliga',     name: 'Bundesliga',     country: 'Germany', searches: ['Bundesliga'] }, // nombre exacto, ver findLeague
  { key: 'ligue-1',        name: 'Ligue 1',        country: 'France',  searches: ['Ligue 1'] },
];

// Ventana hacia ATRÁS: partidos jugados en los últimos N días.
// Con cadencia semanal, 10 días da margen sin traer de más.
const WINDOW_DAYS_BACK = 10;

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

// Mismo criterio que ya nos mordió con Bundesliga: nunca tomar comps[0]
// a ciegas, filtrar por nombre exacto para no matchear "2. Bundesliga".
async function findLeague(liga) {
  console.log(`\n[${ts()}] 🔍 Buscando ${liga.name}...`);
  for (const term of liga.searches) {
    const comps = await fetchAll(`/football/competitions?search=${encodeURIComponent(term)}&country=${encodeURIComponent(liga.country)}&type=league`);
    let comp = comps.find(c => c.name === liga.name || c.name.toLowerCase() === liga.name.toLowerCase());
    if (!comp) comp = comps.find(c => !/^(2\.|3\.)/.test(c.name));
    if (comp) {
      console.log(`   comp_id=${comp.id}`);
      const seasons = await api(`/football/competitions/${comp.id}/seasons`);
      const sCurr = (seasons.data || []).find(s => s.is_current);
      if (sCurr) {
        console.log(`   season_id=${sCurr.id} (${sCurr.name})`);
        return { comp_id: comp.id, season_id: sCurr.id };
      }
    }
  }
  throw new Error(`No encontré ${liga.name}`);
}

function splitStat(stats, statPath){
  // statPath ej: ['overview','corner_kicks','all']
  // ACTUALIZADO: ya no suma home+away -- el aprendizaje por equipo necesita
  // el desglose, no el total. Devuelve {home, away} o null si no hay dato.
  let node = stats;
  for (const k of statPath) node = node?.[k];
  if (!node) return null;
  return { home: node.home ?? null, away: node.away ?? null };
}

async function procesarLiga(liga, resultado) {
  const { comp_id, season_id } = await findLeague(liga);

  const hoy = new Date();
  const desde = new Date(hoy); desde.setDate(desde.getDate() - WINDOW_DAYS_BACK);

  console.log(`   Descargando partidos terminados (últimos ${WINDOW_DAYS_BACK} días)...`);
  const partidos = await fetchAll(`/football/matches?competition_id=${comp_id}&season_id=${season_id}&status=finished&stage=regular`);
  const recientes = partidos.filter(m => {
    const d = new Date(m.utc_date);
    return d >= desde && d <= hoy;
  });
  console.log(`   ${recientes.length} partidos recientes`);

  let conStats = 0, sinStats = 0;
  for (const m of recientes) {
    let stats = null;
    try {
      const r = await api(`/football/matches/${m.id}/stats`);
      stats = r.data;
      conStats++;
    } catch(e) { sinStats++; }

    const corners = splitStat(stats, ['overview','corner_kicks','all']);
    const sot     = splitStat(stats, ['overview','shots_on_target','all']);
    const cards   = splitStat(stats, ['overview','yellow_cards','all']);

    resultado[liga.key] = resultado[liga.key] || {};
    resultado[liga.key][`${m.home_team.name}||${m.away_team.name}`] = {
      homeGoals: m.score?.home ?? null,
      awayGoals: m.score?.away ?? null,
      // Desglose local/visitante (esquema nuevo). Queda null si el partido
      // no tuvo stats detalladas -- se preserva el hueco, no se inventa.
      homeCorners: corners?.home ?? null, awayCorners: corners?.away ?? null,
      homeSOT: sot?.home ?? null, awaySOT: sot?.away ?? null,
      homeCards: cards?.home ?? null, awayCards: cards?.away ?? null,
      date: m.utc_date,
    };
    await sleep(200);
  }
  console.log(`   ✅ ${conStats} con stats completas, ${sinStats} solo con marcador`);
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
    fs.writeFileSync('resultados_reales.json', JSON.stringify({ extracted_at: new Date().toISOString(), leagues: resultado }, null, 2));
  }

  const total = Object.values(resultado).reduce((s,l)=>s+Object.keys(l).length, 0);
  console.log('\n════════════════════════════════');
  console.log(`✅ resultados_reales.json guardado — ${total} partidos`);
  console.log('   ⚠️  Verificar nombres de equipo contra teams{} antes de');
  console.log('       pegar en resultsDB (Claude Code lo hace automático');
  console.log('       según CLAUDE.md, o pedíselo explícitamente).');
  console.log('════════════════════════════════');
}
main().catch(e => { console.error('Error fatal:', e); process.exit(1); });
