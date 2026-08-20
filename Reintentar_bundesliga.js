// ============================================================
// REINTENTO — Bundesliga (1ª división), corrigiendo el match erróneo
// contra 2. Bundesliga de la corrida anterior.
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

// CORREGIDO: en vez de tomar el primer resultado a ciegas, filtra por
// nombre EXACTO "Bundesliga" (descarta "2. Bundesliga", "3. Liga", etc.)
async function findBundesliga() {
  console.log(`\n[${ts()}] 🔍 Buscando Bundesliga (1ª división, nombre exacto)...`);
  const comps = await fetchAll(`/football/competitions?search=Bundesliga&country=Germany&type=league`);
  console.log(`   Encontradas ${comps.length} competencias con "Bundesliga" en el nombre:`);
  comps.forEach(c => console.log(`      - "${c.name}" (id=${c.id}, tier=${c.tier ?? '?'})`));

  // Preferencia: nombre EXACTO "Bundesliga", si no existe, el de tier más alto
  let comp = comps.find(c => c.name === 'Bundesliga');
  if (!comp) comp = comps.find(c => c.name.toLowerCase() === 'bundesliga');
  if (!comp) {
    // último recurso: descartar explícitamente los que dicen "2." o "3."
    comp = comps.find(c => !/^(2\.|3\.)/.test(c.name));
  }
  if (!comp) throw new Error('No pude identificar la Bundesliga de primera con certeza. Revisá la lista de arriba y decime el id exacto.');

  console.log(`   ✅ Elegida: "${comp.name}" (id=${comp.id})`);
  const seasons = await api(`/football/competitions/${comp.id}/seasons`);
  const s2526 = (seasons.data || []).find(s => s.year === '25/26');
  const sCurr = (seasons.data || []).find(s => s.is_current);
  const season = s2526 || sCurr;
  if (!season) throw new Error('No encontré temporada 25/26 para la Bundesliga real.');
  console.log(`   season_id=${season.id} (${season.name})`);
  return { comp_id: comp.id, season_id: season.id };
}

function acumular(equipos, teamId, teamName, rol, score, stats) {
  if (!equipos[teamId]) equipos[teamId] = { id: teamId, name: teamName, pj:0, statsPj:0, gf:0, ga:0, xg:0, xga:0, sot_f:0, sot_a:0, cf:0, ca:0, yc:0 };
  const t = equipos[teamId]; const rival = rol === 'home' ? 'away' : 'home';
  t.pj++; t.gf += score?.[rol] ?? 0; t.ga += score?.[rival] ?? 0;
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
    resultado[t.name] = { id: t.id, pj: t.pj, stats_pj: n, gf: t.gf, ga: t.ga,
      xg: n?+(t.xg/n).toFixed(2):null, xga: n?+(t.xga/n).toFixed(2):null,
      sf: n?+(t.sot_f/n).toFixed(2):null, sa: n?+(t.sot_a/n).toFixed(2):null,
      cf: n?+(t.cf/n).toFixed(2):null, ca: n?+(t.ca/n).toFixed(2):null,
      cards: n?+(t.yc/n).toFixed(2):null };
  }
  const teams = Object.values(resultado);
  const withStats = teams.filter(t => t.stats_pj > 0);
  const n2 = withStats.length || 1;
  return { total_matches: partidos.length,
    league_averages: {
      homeAvg: +(partidos.reduce((s,m)=>s+(m.score?.home??0),0)/partidos.length).toFixed(3),
      awayAvg: +(partidos.reduce((s,m)=>s+(m.score?.away??0),0)/partidos.length).toFixed(3),
      cornerHomeAvg: withStats.length?+(withStats.reduce((s,t)=>s+(t.cf||0),0)/n2).toFixed(2):null,
      cornerAwayAvg: withStats.length?+(withStats.reduce((s,t)=>s+(t.ca||0),0)/n2).toFixed(2):null,
      sotHomeAvg: withStats.length?+(withStats.reduce((s,t)=>s+(t.sf||0),0)/n2).toFixed(2):null,
      sotAwayAvg: withStats.length?+(withStats.reduce((s,t)=>s+(t.sa||0),0)/n2).toFixed(2):null,
    }, teams: resultado };
}

async function main() {
  if (!API_KEY) { console.error('❌ Falta la variable de entorno THESTATSAPI_KEY (ver el comentario arriba de la declaración de API_KEY).'); process.exit(1); }
  const fs = require('fs');
  console.log('⏸ Esperando 45s antes de empezar...\n');
  await sleep(45000);

  const { comp_id, season_id } = await findBundesliga();
  console.log(`   Descargando calendario...`);
  const partidos = await fetchAll(`/football/matches?competition_id=${comp_id}&season_id=${season_id}&status=finished&stage=regular`);
  console.log(`   ${partidos.length} partidos. ≈${Math.ceil(partidos.length*REQUEST_DELAY_MS/1000/60)} min estimados.\n`);

  const equipos = {}; let conStats=0, sinStats=0; const inicio = Date.now();
  for (let i = 0; i < partidos.length; i++) {
    const m = partidos[i];
    let stats = null;
    try { const s = await api(`/football/matches/${m.id}/stats`); stats = s.data; conStats++; }
    catch(e) { sinStats++; }
    acumular(equipos, m.home_team.id, m.home_team.name, 'home', m.score, stats);
    acumular(equipos, m.away_team.id, m.away_team.name, 'away', m.score, stats);
    if ((i+1)%15===0 || i===partidos.length-1) {
      const el=((Date.now()-inicio)/60000).toFixed(1);
      process.stdout.write(`   [${ts()}] ${i+1}/${partidos.length} (${el} min)\r`);
      fs.writeFileSync('bundesliga_correcta.json', JSON.stringify({ 'bundesliga': { ...finalizar(equipos, partidos.slice(0,i+1)), en_progreso: (i+1)<partidos.length } }, null, 2));
    }
  }
  console.log(`\n   ✅ ${conStats} con stats, ${sinStats} sin stats`);
  fs.writeFileSync('bundesliga_correcta.json', JSON.stringify({ 'bundesliga': finalizar(equipos, partidos) }, null, 2));
  console.log('\n════════════════════════════════');
  console.log('✅ bundesliga_correcta.json guardado');
  console.log('📎 Subile ese archivo a Claude');
  console.log('════════════════════════════════');
}
main().catch(e => { console.error('Error fatal:', e); process.exit(1); });
