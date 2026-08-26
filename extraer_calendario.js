// ============================================================
// EXTRACTOR DE CALENDARIO — TheStatsAPI
// Trae TODOS los partidos de la temporada actual (jugados y por jugar,
// sin filtro de status ni ventana de días) de las 5 ligas: equipos, fecha
// y jornada. No trae marcador ni cuotas -- solo sirve para comparar contra
// fixtures[] de cada liga en poisson-multiliga.html y detectar partidos
// que cambiaron de fecha (aplazamientos, adelantos, huecos por el Mundial).
//
// USO:
//   1. Poné la variable de entorno THESTATSAPI_KEY
//   2. node extraer_calendario.js
//   3. Comparar calendario_real.json contra fixtures[] antes de pegar nada
//      (verificar nombres de equipo contra teams{} de cada liga primero)
// ============================================================

// La key ya NO se escribe acá adentro (para poder subir este archivo a
// GitHub sin exponerla). Se lee de una variable de entorno.
//   Local, PowerShell, solo esta sesión: $env:THESTATSAPI_KEY="tu_key_real"
//   Local, permanente: buscar "Variables de entorno" en Windows y agregarla ahí
//     (después hay que reabrir la terminal/VS Code para que la vea)
//   Rutina de Claude Code: configurarla en la sección "Environment" de la rutina
const API_KEY = process.env.THESTATSAPI_KEY;
const BASE    = 'https://api.thestatsapi.com/api';
const REQUEST_DELAY_MS = 3000; // mismo ritmo conservador que el resto de los scripts

const LIGAS = [
  { key: 'premier-league', name: 'Premier League', country: 'England', searches: ['Premier League'] },
  { key: 'la-liga',        name: 'La Liga',        country: 'Spain',   searches: ['LaLiga', 'La Liga', 'Primera Division'] },
  { key: 'serie-a',        name: 'Serie A',        country: 'Italy',   searches: ['Serie A'] },
  { key: 'bundesliga',     name: 'Bundesliga',     country: 'Germany', searches: ['Bundesliga'] }, // filtra nombre exacto abajo
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

async function procesarLiga(liga, resultado) {
  const { comp_id, season_id } = await findLeague(liga);

  // Sin filtro de status ni ventana de fechas: toda la temporada regular,
  // jugada o por jugar. La decisión (25/08/2026) fue traer el calendario
  // completo, no solo una ventana de próximos días -- para poder comparar
  // fixtures[] entero, incluidos partidos ya jugados que puedan tener
  // fecha distinta a la cargada originalmente.
  console.log(`   Descargando calendario completo...`);
  const partidos = await fetchAll(`/football/matches?competition_id=${comp_id}&season_id=${season_id}&stage=regular`);
  console.log(`   ${partidos.length} partidos en la temporada`);

  resultado[liga.key] = partidos.map(m => ({
    mw: m.matchday ?? null,
    date: m.utc_date,
    home: m.home_team?.name ?? null,
    away: m.away_team?.name ?? null,
    status: m.status ?? null,
  })).sort((a, b) => new Date(a.date) - new Date(b.date));
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
    fs.writeFileSync('calendario_real.json', JSON.stringify({ extracted_at: new Date().toISOString(), leagues: resultado }, null, 2));
  }

  const total = Object.values(resultado).reduce((s,l)=>s+(l?.length||0), 0);
  console.log('\n════════════════════════════════');
  console.log(`✅ calendario_real.json guardado — ${total} partidos`);
  console.log('   ⚠️  Comparar contra fixtures[] y verificar nombres de equipo');
  console.log('       contra teams{} antes de pegar nada (según CLAUDE.md).');
  console.log('════════════════════════════════');
}
main().catch(e => { console.error('Error fatal:', e); process.exit(1); });
