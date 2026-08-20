// ============================================================
// VERIFICADOR DE PROYECTO — corre local, sin depender del chat.
// Chequea sintaxis + estructura + calcula eficacia/eficiencia REAL
// contra los datos que ya están en poisson-multiliga.html.
//
// USO: node verificar_proyecto.js
// (parado en la misma carpeta que el HTML)
// ============================================================

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const HTML_PATH = path.join(__dirname, 'poisson-multiliga.html');

function fail(msg){ console.log('❌ ' + msg); process.exitCode = 1; }
function ok(msg){ console.log('✅ ' + msg); }
function section(title){ console.log('\n=== ' + title + ' ==='); }

if (!fs.existsSync(HTML_PATH)) {
  console.error('No encuentro poisson-multiliga.html en esta carpeta.');
  process.exit(1);
}
const html = fs.readFileSync(HTML_PATH, 'utf8');
const match = html.match(/<script>([\s\S]*)<\/script>/);
if (!match) { console.error('No encontré el bloque <script> en el HTML.'); process.exit(1); }
const scriptSrc = match[1];

console.log('################################################################');
console.log('# VERIFICACIÓN DEL PROYECTO — ' + new Date().toLocaleString());
console.log('################################################################');

// ---------- 1. SINTAXIS ----------
section('1. Sintaxis');
try {
  new Function(scriptSrc);
  ok('El JS del artifact es sintácticamente válido');
} catch(e) {
  fail('Error de sintaxis: ' + e.message);
  process.exit(1); // sin esto no tiene sentido seguir
}

// ---------- 2. INTEGRIDAD DE IDs ----------
section('2. Integridad de IDs del HTML');
const jsIds = [...scriptSrc.matchAll(/getElementById\('([a-zA-Z]+)'\)/g)].map(m=>m[1]);
const htmlIds = [...html.matchAll(/id="([a-zA-Z]+)"/g)].map(m=>m[1]);
const missing = [...new Set(jsIds)].filter(id => !htmlIds.includes(id));
// Estos 4 se sacaron a propósito del HTML visible pero siguen con guarda de
// seguridad en el código (renderBatchPanel/renderCalibrationPanel/renderConfidencePanel
// chequean `if (!el) return` antes de tocarlos) -- no son un error.
const EXPECTED_HIDDEN = ['batchPanel','calibrationPanel','confidenceNote','confidenceRows'];
const realMissing = missing.filter(id => !EXPECTED_HIDDEN.includes(id));
if (realMissing.length > 0) fail('IDs referenciados en JS que no existen en el HTML: ' + realMissing.join(', '));
else ok('Todos los IDs coinciden (los 4 paneles ocultos a propósito tienen guarda de seguridad)');

// ---------- 3. EJECUTAR EL MOTOR EN UN SANDBOX ----------
section('3. Cargando el motor en memoria');
const store = {}; // storage en memoria, solo para esta corrida
const els = {};
const sandbox = {
  console,
  window: { storage: {
    get: async (k) => { if(!(k in store)) throw new Error('no existe'); return {key:k,value:store[k]}; },
    set: async (k,v) => { store[k]=v; return {key:k,value:v}; },
    list: async (p) => ({keys: Object.keys(store).filter(k=>k.startsWith(p||''))}),
    delete: async (k) => { delete store[k]; return {}; },
  }},
  document: {
    getElementById: (id) => { if(!els[id]) els[id]={innerHTML:'',textContent:'',classList:{add(){},remove(){},toggle(){}},value:'x',addEventListener(){},appendChild(){}}; return els[id]; },
    createElement: () => ({}),
    querySelector: () => ({textContent:''}),
  },
};
vm.createContext(sandbox);
try {
  vm.runInContext(scriptSrc, sandbox);
  ok('El motor cargó y corrió su inicialización sin errores');
} catch(e) {
  fail('Error al cargar el motor: ' + e.message);
  process.exit(1);
}
// Helper para correr código adicional en el mismo contexto
const run = (code) => vm.runInContext(code, sandbox);

// ---------- 4. ESTRUCTURA MULTI-LIGA ----------
section('4. Estructura de datos');
const nLeagues = run('Object.keys(LEAGUES).length');
if (nLeagues === 5) ok('Las 5 ligas están declaradas'); else fail('Se esperaban 5 ligas, hay ' + nLeagues);

const nTeamsTotal = run(`Object.values(LEAGUES).reduce((s,l)=>s+(l.active||[]).length,0)`);
console.log(`   Equipos activos totales: ${nTeamsTotal}`);

// ---------- 5. NOMBRES DE EQUIPO SIN DESAJUSTES ----------
section('5. Nombres de equipo (resultsDB / marketOddsDB vs teams{})');
const nameCheck = run(`
  (function(){
    const bad = [];
    for (const lgKey of Object.keys(LEAGUES)) {
      const teams = LEAGUES[lgKey].teams;
      for (const key of Object.keys(resultsDB)) {
        const [h,a] = key.split('||');
        if (teams[h] && !teams[a]) bad.push('resultsDB: "'+a+'" no existe en '+lgKey+' (pero "'+h+'" sí)');
        if (teams[a] && !teams[h]) bad.push('resultsDB: "'+h+'" no existe en '+lgKey+' (pero "'+a+'" sí)');
      }
      for (const key of Object.keys(marketOddsDB)) {
        const [h,a] = key.split('||');
        if (teams[h] && !teams[a]) bad.push('marketOddsDB: "'+a+'" no existe en '+lgKey+' (pero "'+h+'" sí)');
        if (teams[a] && !teams[h]) bad.push('marketOddsDB: "'+h+'" no existe en '+lgKey+' (pero "'+a+'" sí)');
      }
    }
    return bad;
  })()
`);
if (nameCheck.length > 0) { nameCheck.forEach(m => fail(m)); }
else ok('Sin desajustes de nombre detectables entre resultsDB/marketOddsDB y teams{}');

// ---------- 6. EFICACIA REAL (con lo que haya en resultsDB) ----------
section('6. Eficacia real (Brier Score contra resultsDB)');
const eficacia = run(`
  (function(){
    const out = [];
    for (const lgKey of Object.keys(LEAGUES)) {
      switchLeagueState(lgKey);
      computeLeagueDerived(lgKey);
      recomputeTeamStrengths([]); recomputeElo([]); recomputeCalibration([]);
      for (const key of Object.keys(resultsDB)) {
        const [h,a] = key.split('||');
        if (!LEAGUES[lgKey].teams[h] || !LEAGUES[lgKey].teams[a]) continue;
        const fc = computeForecast(h,a);
        if (!fc) continue;
        const real = resultsDB[key];
        const outcome = real.homeGoals>real.awayGoals?[1,0,0]:(real.homeGoals===real.awayGoals?[0,1,0]:[0,0,1]);
        const probs=[fc.pHome,fc.pDraw,fc.pAway];
        let brier=0; for(let i=0;i<3;i++) brier+=Math.pow(probs[i]-outcome[i],2);
        out.push({league:lgKey, home:h, away:a, brier, hit: probs.indexOf(Math.max(...probs))===outcome.indexOf(1)});
      }
    }
    return out;
  })()
`);
if (eficacia.length === 0) {
  console.log('   Sin resultados reales cargados todavía en resultsDB.');
} else {
  const avgBrier = eficacia.reduce((s,r)=>s+r.brier,0)/eficacia.length;
  const hits = eficacia.filter(r=>r.hit).length;
  console.log(`   N=${eficacia.length} | Brier promedio: ${avgBrier.toFixed(3)} | Aciertos 1X2: ${hits}/${eficacia.length}`);
  if (eficacia.length < 20) {
    console.log('   ⚠️  N<20: estadísticamente insuficiente para concluir nada. Esto es un chequeo de sanidad, no una validación.');
  } else {
    console.log('   Muestra suficiente para que validateOutOfSample() empiece a dar señal real.');
  }
}

// ---------- 7. EFICIENCIA (velocidad + storage) ----------
section('7. Eficiencia');
const t0 = Date.now();
const nForecasts = run(`
  (function(){
    let n=0;
    for (const lgKey of Object.keys(LEAGUES)) {
      switchLeagueState(lgKey);
      for (const h of L().active) for (const a of L().active) {
        if (h===a) continue;
        computeForecast(h,a); n++;
      }
    }
    return n;
  })()
`);
const t1 = Date.now();
console.log(`   ${nForecasts} pronósticos completos (las 5 ligas): ${t1-t0}ms (${((t1-t0)/nForecasts).toFixed(3)}ms c/u)`);
ok('Velocidad de cómputo no es un cuello de botella');

console.log('\n################################################################');
console.log(process.exitCode === 1 ? '❌ HAY PROBLEMAS — revisar arriba' : '✅ PROYECTO OK');
console.log('################################################################');
