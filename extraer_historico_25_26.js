// ============================================================
// EXTRACTOR HISTÓRICO 25-26 — para backtesting walk-forward
// Trae SOLO fecha+equipos+marcador de los 380 partidos de cada liga
// (temporada 25-26 completa). No necesita stats detalladas: el motor
// de aprendizaje genera su propio xG implícito en cada paso del backtest.
//
// USO: node extraer_historico_25_26.js
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

// Mismo criterio anti-bug de siempre: nombre EXACTO, nunca comps[0] a ciegas
async function findLeague25_26(liga) {
  console.log(`\n[${ts()}] 🔍 Buscando ${liga.name} (temporada 25/26)...`);
  for (const term of liga.searches) {
    const comps = await fetchAll(`/football/competitions?search=${encodeURIComponent(term)}&country=${encodeURIComponent(liga.country)}&type=league`);
    let comp = comps.find(c => c.name === liga.name || c.name.toLowerCase() === liga.name.toLowerCase());
    if (!comp) comp = comps.find(c => !/^(2\.|3\.)/.test(c.name));
    if (comp) {
      const seasons = await api(`/football/competitions/${comp.id}/seasons`);
      const s2526 = (seasons.data || []).find(s => s.year === '25/26');
      if (s2526) {
        console.log(`   comp_id=${comp.id} | season_id=${s2526.id} (${s2526.name})`);
        return { comp_id: comp.id, season_id: s2526.id };
      }
    }
  }
  throw new Error(`No encontré la temporada 25/26 de ${liga.name}`);
}

async function main() {
  if (!API_KEY) { console.error('❌ Falta la variable de entorno THESTATSAPI_KEY (ver el comentario arriba de la declaración de API_KEY).'); process.exit(1); }
  const fs = require('fs');
  const resultado = {};

  for (const liga of LIGAS) {
    try {
      const { comp_id, season_id } = await findLeague25_26(liga);
      console.log(`   Descargando los 380 (o 306) partidos de la temporada...`);
      const partidos = await fetchAll(`/football/matches?competition_id=${comp_id}&season_id=${season_id}&status=finished&stage=regular`);

      // Solo lo esencial: fecha, equipos, marcador. Ordenado cronológicamente.
      const simplificado = partidos
        .map(m => ({
          date: m.utc_date,
          matchday: m.matchday,
          home: m.home_team.name,
          away: m.away_team.name,
          homeGoals: m.score?.home ?? null,
          awayGoals: m.score?.away ?? null,
        }))
        .filter(m => m.homeGoals !== null && m.awayGoals !== null)
        .sort((a,b) => new Date(a.date) - new Date(b.date));

      resultado[liga.key] = simplificado;
      console.log(`   ✅ ${simplificado.length} partidos guardados`);
    } catch(e) {
      console.error(`❌ Error en ${liga.name}:`, e.message);
    }
    fs.writeFileSync('historico_25_26.json', JSON.stringify(resultado, null, 2));
  }

  const total = Object.values(resultado).reduce((s,l)=>s+l.length, 0);
  console.log('\n════════════════════════════════');
  console.log(`✅ historico_25_26.json guardado — ${total} partidos en total`);
  console.log('📎 Subile ese archivo a Claude para correr el backtest');
  console.log('════════════════════════════════');
}
main().catch(e => { console.error('Error fatal:', e); process.exit(1); });
