// ============================================================
// EXTRACTOR HISTÓRICO COMPLETO 25-26 — con xG y desglose por partido
// Extiende extraer_historico_25_26.js: además de fecha/equipos/marcador,
// trae xG, corners, tiros a puerta y tarjetas POR PARTIDO (no agregado a
// temporada), con desglose local/visitante. Necesario para validar
// empíricamente XG_WEIGHT y las constantes de shrinkage, que hoy son
// criterio propio sin evidencia real detrás.
//
// MÁS LENTO que el histórico simple: necesita 1 llamada extra por partido
// (además de la lista), ~1751 partidos × 3s = ~90 minutos. Guarda progreso
// cada 15 partidos, así que si se corta a la mitad no se pierde nada -- se
// puede retomar re-corriendo el script (salta las ligas ya completas).
//
// USO: node extraer_historico_completo.js
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
    console.log(`   [${ts()}] ⏳ 429, reintento en 20s...`);
    await sleep(20000);
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

function splitStat(stats, statPath){
  let node = stats;
  for (const k of statPath) node = node?.[k];
  if (!node) return { home: null, away: null };
  return { home: node.home ?? null, away: node.away ?? null };
}

async function procesarLiga(liga, resultado, fs) {
  const { comp_id, season_id } = await findLeague25_26(liga);
  console.log(`   Descargando calendario...`);
  const partidos = await fetchAll(`/football/matches?competition_id=${comp_id}&season_id=${season_id}&status=finished&stage=regular`);
  console.log(`   ${partidos.length} partidos. ≈${Math.ceil(partidos.length*REQUEST_DELAY_MS/1000/60)} min estimados.\n`);

  const salida = [];
  let conStats = 0, sinStats = 0;
  const inicio = Date.now();

  for (let i = 0; i < partidos.length; i++) {
    const m = partidos[i];
    let stats = null;
    try {
      const r = await api(`/football/matches/${m.id}/stats`);
      stats = r.data;
      conStats++;
    } catch(e) { sinStats++; }

    const xg = splitStat(stats, ['overview','expected_goals','all']);
    const corners = splitStat(stats, ['overview','corner_kicks','all']);
    const sot = splitStat(stats, ['overview','shots_on_target','all']);
    const cards = splitStat(stats, ['overview','yellow_cards','all']);

    salida.push({
      date: m.utc_date, matchday: m.matchday,
      home: m.home_team.name, away: m.away_team.name,
      homeGoals: m.score?.home ?? null, awayGoals: m.score?.away ?? null,
      homeXG: xg.home, awayXG: xg.away,
      homeCorners: corners.home, awayCorners: corners.away,
      homeSOT: sot.home, awaySOT: sot.away,
      homeCards: cards.home, awayCards: cards.away,
    });

    if ((i+1) % 15 === 0 || i === partidos.length-1) {
      const el = ((Date.now()-inicio)/60000).toFixed(1);
      process.stdout.write(`   [${ts()}] ${i+1}/${partidos.length} (${el} min)\r`);
      resultado[liga.key] = salida;
      fs.writeFileSync('historico_completo_25_26.json', JSON.stringify(resultado, null, 2));
    }
  }
  console.log(`\n   ✅ ${conStats} con stats detalladas, ${sinStats} solo con marcador`);
  salida.sort((a,b)=> new Date(a.date)-new Date(b.date)); // CRÍTICO para backtesting: nunca guardar sin ordenar (bug que costó re-ordenar 1751 partidos a mano la vez pasada)
  resultado[liga.key] = salida;
}

async function main() {
  if (!API_KEY) { console.error('❌ Falta la variable de entorno THESTATSAPI_KEY (ver el comentario arriba de la declaración de API_KEY).'); process.exit(1); }
  const fs = require('fs');
  let resultado = {};
  if (fs.existsSync('historico_completo_25_26.json')) {
    try {
      resultado = JSON.parse(fs.readFileSync('historico_completo_25_26.json','utf8'));
      console.log(`📂 Progreso previo encontrado: ${Object.keys(resultado).join(', ')}`);
    } catch(e) {}
  }

  const pendientes = LIGAS.filter(l => !resultado[l.key] || resultado[l.key].length === 0);
  console.log(`\n⏳ A procesar: ${pendientes.map(l=>l.name).join(', ') || '(nada, todo ya está completo)'}`);

  for (const liga of pendientes) {
    try {
      await procesarLiga(liga, resultado, fs);
      console.log(`[${ts()}] ✅ ${liga.name} completada\n`);
    } catch(e) {
      console.error(`[${ts()}] ❌ Error en ${liga.name}:`, e.message);
      console.log('   Sigo con la próxima liga...\n');
    }
    fs.writeFileSync('historico_completo_25_26.json', JSON.stringify(resultado, null, 2));
  }

  const total = Object.values(resultado).reduce((s,l)=>s+l.length, 0);
  console.log('\n════════════════════════════════');
  console.log(`✅ historico_completo_25_26.json guardado — ${total} partidos con xG y desglose`);
  console.log('📎 Subile ese archivo a Claude para validar XG_WEIGHT y las constantes de shrinkage');
  console.log('════════════════════════════════');
}
main().catch(e => { console.error('Error fatal:', e); process.exit(1); });
