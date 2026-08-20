// ============================================================
// EXTRACTOR v5 — nombres alternativos por liga + reintentos ACOTADOS
// de verdad (nunca más de 40s perdidos por partido, sin importar qué)
// ============================================================

// La key ya NO se escribe acá adentro (para poder subir este archivo a
// GitHub sin exponerla). Se lee de una variable de entorno.
//   Local, PowerShell, solo esta sesión: $env:THESTATSAPI_KEY="tu_key_real"
//   Local, permanente: buscar "Variables de entorno" en Windows y agregarla ahí
//     (después hay que reabrir la terminal/VS Code para que la vea)
//   Rutina de Claude Code: configurarla en la sección "Environment" de la rutina
const API_KEY = process.env.THESTATSAPI_KEY;
const BASE    = 'https://api.thestatsapi.com/api';

// Ritmo fijo conservador: 1 pedido cada 3s = 20 req/min.
// El comportamiento observado sugiere un límite real más estricto
// que el documentado, así que vamos más despacio de lo "necesario".
const REQUEST_DELAY_MS = 3000;

// Ya completadas con éxito (no las repite)
const YA_PROCESADAS = {
  'premier-league': true,   // ✅ 350/350, 100% cobertura
  'la-liga':        false,
  'serie-a':        false,  // quedó a medias, la retoma
  'bundesliga':     false,
  'ligue-1':        false,
};

// Varios nombres/búsquedas alternativas por liga, por si el nombre
// exacto no coincide con cómo está registrada en la API.
const LIGAS = [
  { key: 'la-liga',    name: 'La Liga',    country: 'Spain',   searches: ['LaLiga', 'La Liga', 'Primera Division', 'La Liga EA Sports'] },
  { key: 'serie-a',    name: 'Serie A',    country: 'Italy',   searches: ['Serie A'] },
  { key: 'bundesliga', name: 'Bundesliga', country: 'Germany', searches: ['Bundesliga', '1. Bundesliga'] },
  { key: 'ligue-1',    name: 'Ligue 1',    country: 'France',  searches: ['Ligue 1', 'Ligue 1 McDonald\'s'] },
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

// Máximo 1 reintento de 20s. Si vuelve a fallar, se da por vencido con
// ESE pedido puntual y sigue adelante — nunca más de ~25s perdidos.
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
    console.log(`   [${ts()}] ⏳ 429, un solo reintento en 20s...`);
    await sleep(20000);
    r = await apiRaw(path);
    if (r.rateLimited) throw new Error(`Rate limit persistente: ${path}`);
  }
  return r.data;
}

async function fetchAll(path, perPage = 100) {
  const items = [];
  let page = 1;
  while (true) {
    const sep  = path.includes('?') ? '&' : '?';
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
    const comps = await fetchAll(
      `/football/competitions?search=${encodeURIComponent(term)}&country=${encodeURIComponent(liga.country)}&type=league`
    );
    if (comps[0]) {
      const comp = comps[0];
      console.log(`   Encontrada con "${term}" → comp_id=${comp.id} | xG=${comp.xg_available}`);
      const seasons = await api(`/football/competitions/${comp.id}/seasons`);
      const s2526 = (seasons.data || []).find(s => s.year === '25/26');
      const sCurr = (seasons.data || []).find(s => s.is_current);
      const season = s2526 || sCurr;
      if (!season) { console.log(`   ⚠️ Sin temporada 25/26, probando siguiente término...`); continue; }
      console.log(`   season_id=${season.id} (${season.name})`);
      return { comp_id: comp.id, season_id: season.id };
    }
  }
  // Ningún término funcionó: listamos TODAS las competencias del país para diagnosticar
  console.log(`   ❌ Ningún término encontró la liga. Listando ligas de ${liga.country}:`);
  const todas = await fetchAll(`/football/competitions?country=${encodeURIComponent(liga.country)}&type=league`);
  todas.forEach(c => console.log(`      - "${c.name}" (id=${c.id})`));
  throw new Error(`No encontré ${liga.name}. Revisá la lista de arriba y decime el nombre exacto.`);
}

function acumular(equipos, teamId, teamName, rol, score, stats) {
  if (!equipos[teamId]) {
    equipos[teamId] = { id: teamId, name: teamName, pj:0, statsPj:0, gf:0, ga:0, xg:0, xga:0, sot_f:0, sot_a:0, cf:0, ca:0, yc:0 };
  }
  const t = equipos[teamId];
  const rival = rol === 'home' ? 'away' : 'home';
  t.pj++;
  t.gf += score?.[rol] ?? 0;
  t.ga += score?.[rival] ?? 0;
  if (!stats) return;
  let huboAlgo = false;
  const xg = stats?.overview?.expected_goals?.all;
  if (xg) { t.xg += xg[rol] ?? 0; t.xga += xg[rival] ?? 0; huboAlgo = true; }
  const sot = stats?.overview?.shots_on_target?.all || stats?.shots?.shots_on_target?.all;
  if (sot) { t.sot_f += sot[rol] ?? 0; t.sot_a += sot[rival] ?? 0; huboAlgo = true; }
  const ck = stats?.overview?.corner_kicks?.all;
  if (ck) { t.cf += ck[rol] ?? 0; t.ca += ck[rival] ?? 0; huboAlgo = true; }
  const yc = stats?.overview?.yellow_cards?.all;
  if (yc) { t.yc += yc[rol] ?? 0; huboAlgo = true; }
  if (huboAlgo) t.statsPj++;
}

function finalizar(equipos, partidos) {
  const resultado = {};
  for (const t of Object.values(equipos)) {
    const n = t.statsPj || 0;
    resultado[t.name] = {
      id: t.id, pj: t.pj, stats_pj: n, gf: t.gf, ga: t.ga,
      xg:  n ? +(t.xg/n).toFixed(2)  : null,
      xga: n ? +(t.xga/n).toFixed(2) : null,
      sf:  n ? +(t.sot_f/n).toFixed(2) : null,
      sa:  n ? +(t.sot_a/n).toFixed(2) : null,
      cf:  n ? +(t.cf/n).toFixed(2)    : null,
      ca:  n ? +(t.ca/n).toFixed(2)    : null,
      cards: n ? +(t.yc/n).toFixed(2)  : null,
    };
  }
  const teams = Object.values(resultado);
  const withStats = teams.filter(t => t.stats_pj > 0);
  const n2 = withStats.length || 1;
  return {
    total_matches: partidos.length,
    league_averages: {
      homeAvg: +(partidos.reduce((s,m)=>s+(m.score?.home??0),0)/partidos.length).toFixed(3),
      awayAvg: +(partidos.reduce((s,m)=>s+(m.score?.away??0),0)/partidos.length).toFixed(3),
      cornerHomeAvg: withStats.length ? +(withStats.reduce((s,t)=>s+(t.cf||0),0)/n2).toFixed(2) : null,
      cornerAwayAvg: withStats.length ? +(withStats.reduce((s,t)=>s+(t.ca||0),0)/n2).toFixed(2) : null,
      sotHomeAvg:    withStats.length ? +(withStats.reduce((s,t)=>s+(t.sf||0),0)/n2).toFixed(2) : null,
      sotAwayAvg:    withStats.length ? +(withStats.reduce((s,t)=>s+(t.sa||0),0)/n2).toFixed(2) : null,
    },
    teams: resultado,
  };
}

async function procesarLiga(liga, fs, output, errores) {
  const { comp_id, season_id } = await findLeague(liga);
  console.log(`   Descargando calendario...`);
  const partidos = await fetchAll(`/football/matches?competition_id=${comp_id}&season_id=${season_id}&status=finished&stage=regular`);
  console.log(`   ${partidos.length} partidos. ≈${Math.ceil(partidos.length*REQUEST_DELAY_MS/1000/60)} min estimados.\n`);

  const equipos = {};
  let conStats = 0, sinStats = 0;
  const inicio = Date.now();

  for (let i = 0; i < partidos.length; i++) {
    const m = partidos[i];
    let stats = null;
    try {
      const s = await api(`/football/matches/${m.id}/stats`);
      stats = s.data;
      conStats++;
    } catch(e) { sinStats++; }

    acumular(equipos, m.home_team.id, m.home_team.name, 'home', m.score, stats);
    acumular(equipos, m.away_team.id, m.away_team.name, 'away', m.score, stats);

    if ((i+1) % 15 === 0 || i === partidos.length-1) {
      const elapsedMin = ((Date.now()-inicio)/60000).toFixed(1);
      process.stdout.write(`   [${ts()}] ${i+1}/${partidos.length} (${elapsedMin} min)\r`);
      const parcial = finalizar(equipos, partidos.slice(0, i+1));
      output[liga.key] = { ...parcial, en_progreso: (i+1) < partidos.length, procesados: i+1 };
      fs.writeFileSync('stats_ligas_v5.json', JSON.stringify({ extracted_at: new Date().toISOString(), errors: errores, leagues: output }, null, 2));
    }
  }
  console.log(`\n   ✅ ${conStats} con stats, ${sinStats} sin stats`);
  return finalizar(equipos, partidos);
}

async function main() {
  if (!API_KEY) { console.error('❌ Falta la variable de entorno THESTATSAPI_KEY (ver el comentario arriba de la declaración de API_KEY).'); process.exit(1); }
  const fs = require('fs');
  let output = {};
  // Migrar resultado de la Premier del v4/v3 si existe
  for (const prevFile of ['stats_ligas_v4.json','stats_ligas_v3.json']) {
    if (fs.existsSync(prevFile)) {
      try {
        const prev = JSON.parse(fs.readFileSync(prevFile,'utf8'));
        if (prev.leagues?.['premier-league'] && !output['premier-league']) {
          output['premier-league'] = prev.leagues['premier-league'];
          console.log(`📂 Premier League recuperada de ${prevFile}`);
        }
      } catch(e) {}
    }
  }
  if (fs.existsSync('stats_ligas_v5.json')) {
    try {
      const prev = JSON.parse(fs.readFileSync('stats_ligas_v5.json','utf8'));
      output = { ...prev.leagues, ...output };
      console.log(`📂 Progreso v5 encontrado: ${Object.keys(output).join(', ')}`);
    } catch(e) {}
  }

  const errores = [];
  const pendientes = LIGAS.filter(l => !YA_PROCESADAS[l.key] && !(output[l.key] && !output[l.key].en_progreso));
  console.log(`\n⏳ A procesar: ${pendientes.map(l=>l.name).join(', ') || '(nada pendiente)'}`);

  for (const liga of pendientes) {
    try {
      output[liga.key] = await procesarLiga(liga, fs, output, errores);
      console.log(`[${ts()}] ✅ ${liga.name} completada\n`);
    } catch(e) {
      console.error(`[${ts()}] ❌ Error en ${liga.name}:`, e.message);
      errores.push({ liga: liga.name, error: e.message });
      console.log('   Sigo con la próxima liga...\n');
    }
    fs.writeFileSync('stats_ligas_v5.json', JSON.stringify({ extracted_at: new Date().toISOString(), errors: errores, leagues: output }, null, 2));
  }

  console.log('\n════════════════════════════════');
  console.log('✅ stats_ligas_v5.json guardado');
  console.log(`   Ligas: ${Object.keys(output).length}/5`);
  console.log('📎 Subile ese archivo a Claude');
  console.log('════════════════════════════════');
}

main().catch(e => { console.error('Error fatal:', e); process.exit(1); });
