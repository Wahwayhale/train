require('./stub-dom.js');
for (const f of ['core','mesh','renderer','textures','align','world','train','physics','pax','traffic','street','audio']) require('./src/'+f+'.js');
require('./data/shanghai.js');
const SH = global.SH;
const gsrc = require('fs').readFileSync('./src/game.js','utf8');
const grab=(n)=>{const i=gsrc.indexOf('class '+n);let d=0;for(let k=gsrc.indexOf('{',i);k<gsrc.length;k++){if(gsrc[k]==='{')d++;else if(gsrc[k]==='}'){d--;if(!d)return gsrc.slice(i,k+1);}}};
Object.assign(global,{CAR_GAP:0.35,MODES:{manual:{}},Builder:SH.Builder,...Object.fromEntries(Object.keys(SH).map(k=>[k,SH[k]]))});
const LR = eval('('+grab('LineRuntime')+')');
for (const id of Object.keys(SH.LINES)) {
  const ln = new LR(SH.LINES[id]);
  const ev = SH.elevFor(ln.al, ln.stations);
  const blocked = ln.stations.filter((n,i)=>ev.h(ln.al.stationS[i])===0).length;
  if (ev.segs.length) console.log(id, 'segs='+ev.segs.length, 'blocked='+blocked+'/'+ln.stations.length);
}
