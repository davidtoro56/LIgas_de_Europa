// ============================================================
// REENTRENAMIENTO AUTOMÁTICO DEL MODELO DE STACKING
//
// Combina la base histórica 25-26 (historico_25_26.json, si está en esta
// carpeta) con los resultados REALES de la 26-27 que ya estén en resultsDB
// (se van acumulando solos con la rutina semanal de extraer_resultados.js).
//
// SALVAGUARDA CENTRAL: nunca reemplaza los coeficientes a ciegas. Entrena un
// modelo candidato, lo compara contra el modelo actual EN DATOS QUE NINGUNO
// DE LOS DOS VIO durante su entrenamiento, y solo actualiza el archivo si el
// candidato gana con un margen real (no ruido). Si no mejora, no toca nada.
//
// USO: node reentrenar_stacking.js
// (parado en la carpeta con poisson-multiliga.html)
// ============================================================

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const HTML_PATH = path.join(__dirname, 'poisson-multiliga.html');
const HIST_PATH = path.join(__dirname, 'historico_25_26.json');
const MIN_IMPROVEMENT_PCT = 0.3; // el candidato debe ganar por al menos esto (evita ruido)

if (!fs.existsSync(HTML_PATH)) { console.error('No encuentro poisson-multiliga.html'); process.exit(1); }

const html = fs.readFileSync(HTML_PATH, 'utf8');
const scriptSrc = html.match(/<script>([\s\S]*)<\/script>/)[1];

let historicoJSON = '{}';
if (fs.existsSync(HIST_PATH)) historicoJSON = fs.readFileSync(HIST_PATH, 'utf8');

// TODO el trabajo corre en el MISMO contexto vm que cargó el motor real
// (LEAGUES, resultsDB, computeMatrix, STACKING_W, etc. declarados con const
// a nivel superior del script NO quedan expuestos como propiedades del
// objeto sandbox -- hay que ejecutar en el mismo scope léxico, no destructurar
// desde afuera).
const analysisCode = `
(function(){
  const historico = ${historicoJSON};
  const MIN_IMPROVEMENT_PCT = ${MIN_IMPROVEMENT_PCT};

  console.log('📂 Base histórica 25-26: ' + Object.values(historico).reduce((s,l)=>s+l.length,0) + ' partidos');

  // Sumar los resultados REALES de la 26-27 que ya estén en resultsDB
  let nuevosDeResultsDB = 0;
  for (const key in resultsDB) {
    const parts = key.split('||');
    const home = parts[0], away = parts[1];
    const r = resultsDB[key];
    if (typeof r.homeGoals !== 'number' || typeof r.awayGoals !== 'number') continue;
    for (const lgKey of Object.keys(LEAGUES)) {
      if (LEAGUES[lgKey].teams[home] && LEAGUES[lgKey].teams[away]) {
        if (!historico[lgKey]) historico[lgKey] = [];
        const yaExiste = historico[lgKey].some(m => m.home===home && m.away===away && m.date===r.date);
        if (!yaExiste) { historico[lgKey].push({date:r.date, home, away, homeGoals:r.homeGoals, awayGoals:r.awayGoals}); nuevosDeResultsDB++; }
        break;
      }
    }
  }
  console.log('📊 Partidos reales 26-27 sumados desde resultsDB: ' + nuevosDeResultsDB);
  for (const lgKey in historico) historico[lgKey].sort((a,b)=>new Date(a.date)-new Date(b.date));

  const totalMatches = Object.values(historico).reduce((s,l)=>s+l.length,0);
  console.log('📈 Total combinado: ' + totalMatches + ' partidos\\n');

  if (totalMatches < 200) {
    console.log('⚠️  Muestra insuficiente (<200). Abortando sin tocar nada.');
    return { skip: true };
  }

  function makeNeutralElo(teamNames){ const r={}; teamNames.forEach(n=>r[n]=1500); return r; }
  function eloExpBT(rh,ra){ return 1/(1+Math.pow(10,(ra-rh)/400)); }
  const BT_K=20, BT_HA=65, BT_PS=12, BT_HL=120;

  function generarPares(){
    const pairs = [];
    for (const lgKey of Object.keys(historico)) {
      if (!LEAGUES[lgKey]) continue;
      const matches = historico[lgKey];
      const HA=LEAGUES[lgKey].homeAvg, AA=LEAGUES[lgKey].awayAvg;
      const teamNames = [...new Set(matches.flatMap(m=>[m.home,m.away]))];
      const hist2={}; teamNames.forEach(n=>hist2[n]=[]);
      const elo = makeNeutralElo(teamNames);
      const gp={}; teamNames.forEach(n=>gp[n]=0);
      for (const m of matches) {
        const refDate=new Date(m.date), h=m.home, a=m.away;
        function ws(team, isAtk){
          const games=hist2[team]; if(games.length===0) return 1;
          let obsSum=0,expSum=0,wSum=0;
          for(const g of games){ const w=Math.pow(0.5,(refDate-new Date(g.date))/(1000*60*60*24)/BT_HL);
            obsSum+=(isAtk?g.gf:g.ga)*w; expSum+=(isAtk?g.gfExp:g.gaExp)*w; wSum+=w; }
          const ratio=expSum>0?obsSum/expSum:1; const weight=wSum/(wSum+BT_PS);
          return 1+weight*(ratio-1);
        }
        const atkH=ws(h,true),defH=ws(h,false),atkA=ws(a,true),defA=ws(a,false);
        const hXG=HA*atkH*defA, aXG=AA*atkA*defH;
        const matrix=computeMatrix(hXG,aXG,7);
        let pH=0,pD=0,pA=0;
        for(let i=0;i<matrix.length;i++) for(let j=0;j<matrix[i].length;j++){ if(i>j)pH+=matrix[i][j]; else if(i===j)pD+=matrix[i][j]; else pA+=matrix[i][j]; }
        const tot=pH+pD+pA; pH/=tot;pD/=tot;pA/=tot;
        const rh=elo[h]+BT_HA, ra=elo[a], expH=eloExpBT(rh,ra);
        const eD=0.28*Math.exp(-Math.pow((rh-ra)/380,2)), eR=1-eD;
        const eH=eR*expH, eA=eR*(1-expH);
        if (gp[h]>=5 && gp[a]>=5) {
          const outcome = m.homeGoals>m.awayGoals?[1,0,0]:(m.homeGoals===m.awayGoals?[0,1,0]:[0,0,1]);
          pairs.push({pPois:[pH,pD,pA], pElo:[eH,eD,eA], outcome, date:m.date});
        }
        hist2[h].push({date:m.date,gf:m.homeGoals,ga:m.awayGoals,gfExp:hXG,gaExp:aXG});
        hist2[a].push({date:m.date,gf:m.awayGoals,ga:m.homeGoals,gfExp:aXG,gaExp:hXG});
        gp[h]++; gp[a]++;
        const scoreH=m.homeGoals>m.awayGoals?1:(m.homeGoals===m.awayGoals?0.5:0);
        const margin=Math.abs(m.homeGoals-m.awayGoals);
        const marginMult=margin<=1?1:(margin===2?1.5:(1.75+(margin-3)/8));
        const delta=BT_K*marginMult*(scoreH-expH);
        elo[h]+=delta; elo[a]-=delta;
      }
    }
    return pairs;
  }

  const pairs = generarPares();
  console.log('✅ ' + pairs.length + ' partidos evaluables (post burn-in)\\n');

  const sortedDates = pairs.map(p=>p.date).sort();
  const splitDate = new Date(sortedDates[Math.floor(sortedDates.length*0.7)]);
  const trainPairs = pairs.filter(p=>new Date(p.date)<splitDate);
  const testPairs = pairs.filter(p=>new Date(p.date)>=splitDate);
  console.log('Split: ' + trainPairs.length + ' train / ' + testPairs.length + ' test\\n');

  function softmaxBT(logits){ const max=Math.max(...logits); const exps=logits.map(l=>Math.exp(l-max)); const sum=exps.reduce((a,b)=>a+b,0); return exps.map(e=>e/sum); }
  function trainStackerBT(data, epochs, lr, l2){
    const nF=6, nC=3;
    let W=Array.from({length:nC},()=>Array(nF).fill(0)), b=Array(nC).fill(0);
    const N=data.length;
    for (let ep=0; ep<epochs; ep++){
      const gW=Array.from({length:nC},()=>Array(nF).fill(0)), gB=Array(nC).fill(0);
      for (const d of data) {
        const x=[...d.pPois,...d.pElo];
        const logits=W.map((wc,c)=>wc.reduce((s,w,i)=>s+w*x[i],0)+b[c]);
        const probs=softmaxBT(logits);
        for (let c=0;c<nC;c++){ const err=probs[c]-d.outcome[c]; for(let i=0;i<nF;i++) gW[c][i]+=err*x[i]; gB[c]+=err; }
      }
      for (let c=0;c<nC;c++){ for(let i=0;i<nF;i++) W[c][i]-=lr*(gW[c][i]/N+l2*W[c][i]); b[c]-=lr*(gB[c]/N); }
    }
    return {W,b};
  }
  function predictBT(model, pPois, pElo){
    const x=[...pPois,...pElo];
    const logits=model.W.map((wc,c)=>wc.reduce((s,w,i)=>s+w*x[i],0)+model.b[c]);
    return softmaxBT(logits);
  }
  function brierOfBT(model, data){
    let sum=0;
    for (const d of data) { const pred=predictBT(model,d.pPois,d.pElo); let b=0; for(let i=0;i<3;i++) b+=Math.pow(pred[i]-d.outcome[i],2); sum+=b; }
    return sum/data.length;
  }

  console.log('🔧 Entrenando modelo candidato...');
  const candidateModel = trainStackerBT(trainPairs, 8000, 0.1, 0.001);
  const candidateTestBrier = brierOfBT(candidateModel, testPairs);

  const currentModel = { W: STACKING_W, b: STACKING_B };
  const currentTestBrier = brierOfBT(currentModel, testPairs);

  console.log('\\n════════════════════════════════');
  console.log('Modelo ACTUAL -- Brier test: ' + currentTestBrier.toFixed(4));
  console.log('Modelo CANDIDATO -- Brier test: ' + candidateTestBrier.toFixed(4));
  const improvementPct = (currentTestBrier - candidateTestBrier)/currentTestBrier*100;
  console.log('Mejora: ' + (improvementPct>=0?'+':'') + improvementPct.toFixed(2) + '%');
  console.log('════════════════════════════════\\n');

  if (improvementPct < MIN_IMPROVEMENT_PCT) {
    console.log('❌ No mejora lo suficiente (umbral ' + MIN_IMPROVEMENT_PCT + '%). Se mantiene el modelo actual.');
    return { skip: true, currentTestBrier, candidateTestBrier, improvementPct };
  }

  console.log('✅ El candidato mejora de verdad. Reentrenando con TODOS los datos...');
  const finalModel = trainStackerBT(pairs, 8000, 0.1, 0.001);
  return {
    skip: false,
    W: finalModel.W.map(row=>row.map(w=>+w.toFixed(6))),
    B: finalModel.b.map(b=>+b.toFixed(6)),
    currentTestBrier, candidateTestBrier, improvementPct
  };
})()
`;

const sandbox = {
  console,
  document: { getElementById: () => ({addEventListener(){},appendChild(){},textContent:'',classList:{add(){},remove(){},toggle(){}},innerHTML:'',value:'Arsenal'}), createElement:()=>({}), querySelector:()=>({textContent:''}) },
  window: { storage: { get: async()=>{throw new Error('stub')}, set: async()=>({}), list: async()=>({keys:[]}), delete: async()=>({}) } },
};
vm.createContext(sandbox);
vm.runInContext(scriptSrc, sandbox); // carga el motor real
const result = vm.runInContext(analysisCode, sandbox); // corre el análisis EN EL MISMO contexto

if (!result.skip) {
  const Wstr = JSON.stringify(result.W);
  const Bstr = JSON.stringify(result.B);
  let newHtml = html.replace(/const STACKING_W = \[.*?\];/, `const STACKING_W = ${Wstr};`);
  newHtml = newHtml.replace(/const STACKING_B = \[.*?\];/, `const STACKING_B = ${Bstr};`);
  fs.writeFileSync(HTML_PATH, newHtml);
  console.log(`\n✅ poisson-multiliga.html actualizado.`);
  console.log(`   Brier: ${result.currentTestBrier.toFixed(4)} -> ${result.candidateTestBrier.toFixed(4)} (${result.improvementPct.toFixed(2)}% mejor, validado fuera de muestra)`);
  console.log('📎 Corré verificar_proyecto.js para confirmar que todo sigue OK.');
}
