require('./stub-dom.js');
for (const f of ['core','mesh','renderer','textures','align','world','train','physics','pax','audio','traffic']) require('./src/'+f+'.js');
require('./data/shanghai.js');
const SH = global.SH;
const src = require('fs').readFileSync('./src/game.js','utf8');
const grab=(n)=>{const i=src.indexOf('class '+n);let d=0;for(let k=src.indexOf('{',i);k<src.length;k++){if(src[k]==='{')d++;else if(src[k]==='}'){d--;if(!d)return src.slice(i,k+1);}}};
const MODES={manual:{name:'人工'},semi:{name:'半自动'},auto:{name:'全自动'}};
Object.assign(global,{CAR_GAP:0.35,MODES,Builder:SH.Builder,Geo:SH.Geo,...Object.fromEntries(Object.keys(SH).map(k=>[k,SH[k]])),C:SH.clamp,cross:SH.Geo.cross,norm3:SH.Geo.norm3});
const LineRuntime=eval('('+grab('LineRuntime')+')'), Session=eval('('+grab('Session')+')');
const app={pa:{welcome(){},departing(){},approaching(){},arriving(){},doorOpen(){},doorClose(){}},audio:{click(){},alarm(){},stopSettle(){},doorOpen(){},doorClose(){}},ato:new SH.physics.ATO('auto'),toast(){},hint(){},showJudge(){},syncLever(){},bakeAhead(){},finishRun(){}};
const ctxOf=s=>({distanceToStop:s.d,speedKmh:s.tr.kmh,limitKmh:s.limit,grade:s.grade,curveK:s.curveK,curveLimit:s.limit,predictStop:s.tr.predictStop(s.grade),perf:s.tr.spec.perf});
const lines=['l1','l2','l3','l6','l11','l16','l17'].map(id=>new LineRuntime(SH.LINES[id]));
function run(bias){
  SH.__atoBias=bias; app.ato=new SH.physics.ATO('auto');
  let errs=[],tot=0,n=0;
  for(const line of lines){
    const s=new Session(app); s.start(line,'auto',3,2);
    const dt=1/30;
    for(let i=0;i<30*700;i++){
      if(s.phase==='stopped'&&!s.doors&&!s._committed) s.openDoors();
      if(s.doors&&s.dwell>3) s.closeDoors();
      s.update(dt); if(s.phase==='finished') break;
    }
    for(const r of s.results) errs.push(r.err);
    if(s.results.length){ tot+=s.summary().total; n++; }
  }
  const mean=errs.reduce((a,b)=>a+b,0)/errs.length;
  const mae=errs.reduce((a,b)=>a+Math.abs(b),0)/errs.length;
  return {bias:+bias.toFixed(2), mean:+mean.toFixed(2), mae:+mae.toFixed(2), worst:+Math.max(...errs.map(Math.abs)).toFixed(2), score:Math.round(tot/Math.max(1,n)), samples:errs.length};
}
console.log('bias   平均误差   平均绝对误差  最差    总分  (7条线×2段)');
for(const b of [-0.7,-1.0,-1.3,-1.6,-2.0,-2.4,-2.8,-3.2]) { const r=run(b); console.log(`${String(r.bias).padStart(5)}   ${String(r.mean).padStart(6)} m   ${String(r.mae).padStart(6)} m   ${String(r.worst).padStart(6)} m   ${String(r.score).padStart(3)}   n=${r.samples}`); }
