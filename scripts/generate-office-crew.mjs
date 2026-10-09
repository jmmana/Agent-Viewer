#!/usr/bin/env node
/**
 * Deterministic technical animation studies. These vectors are NOT faithful
 * raster exports of the approved CEO illustration and must not replace PNGs.
 * No third-party art, network requests or image mirroring. Run from any cwd.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
const checkOnly = process.argv.includes('--check');
const roles = {
  ceo: { coat:'#1E3A8A', accent:'#2563EB', dark:'#172D54', glasses:'rect', prop:'tablet' },
  planner: { coat:'#7C3AED', accent:'#2563EB', dark:'#4C2584', glasses:'round', prop:'clipboard' },
  developer: { coat:'#2563EB', accent:'#22D3EE', dark:'#153F84', glasses:'rect', prop:'laptop' },
  analyst: { coat:'#0D9488', accent:'#16A34A', dark:'#075F5B', glasses:'large', prop:'analytics' },
  reviewer: { coat:'#EA580C', accent:'#DC6C62', dark:'#9A401E', glasses:'thin', prop:'clipboard' },
  finance: { coat:'#166534', accent:'#5E9770', dark:'#123D27', glasses:'classic', prop:'calculator' },
};
const clips = {
  idle:{frames:4,fps:6,loop:true}, walk:{frames:6,fps:10,loop:true},
  think:{frames:4,fps:5,loop:true}, talk:{frames:6,fps:8,loop:true},
  work:{frames:6,fps:8,loop:true}, review:{frames:6,fps:6,loop:true},
  phone:{frames:6,fps:8,loop:true}, blocked:{frames:4,fps:5,loop:true},
  completed:{frames:6,fps:10,loop:false}, sit:{frames:6,fps:10,loop:false},
  stand:{frames:6,fps:10,loop:false}, approve:{frames:6,fps:8,loop:false},
};
const facings = ['front','back','left','right'];
const n = x => Math.round(x * 100) / 100;
const group = (id, body, transform='') => `<g id="${id}"${transform ? ` transform="${transform}"` : ''}>${body}</g>`;
const path = (d, fill, extra='') => `<path d="${d}" fill="${fill}" ${extra}/>`;
const line = (d, color='#382A28', width=2) => path(d,'none',`stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"`);
const rect = (x,y,w,h,fill,rx=3,extra='') => `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${rx}" fill="${fill}" ${extra}/>`;
const ellipse = (x,y,rx,ry,fill,extra='') => `<ellipse cx="${n(x)}" cy="${n(y)}" rx="${n(rx)}" ry="${n(ry)}" fill="${fill}" ${extra}/>`;
const skin = 'url(#skin)';
function defs(r) {
  return `<defs><linearGradient id="skin" x1="0" y1="0" x2=".7" y2="1"><stop stop-color="#FFE2BC"/><stop offset="1" stop-color="#F5AD79"/></linearGradient><linearGradient id="hair" x1="0" y1="0" x2=".6" y2="1"><stop stop-color="#674636"/><stop offset=".6" stop-color="#3A2925"/><stop offset="1" stop-color="#241D22"/></linearGradient><linearGradient id="coat" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${r.coat}"/><stop offset="1" stop-color="${r.dark}"/></linearGradient></defs>`;
}
function eye(x,y,blink,focused=false) {
  if (blink) return line(`M${x-8} ${y} Q${x} ${y-5} ${x+8} ${y}`,'#2A2224',2.5);
  return ellipse(x,y,10,12,'#FFF8EF')+ellipse(x+(focused?2:0),y+1,7,10,'#583C2A')+ellipse(x+(focused?2:0),y+1,5,8,'#181C23')+ellipse(x-2,y-4,2.7,3.5,'white');
}
function faceFront(r,clip,i) {
  const blink = (clip==='idle' && i===2)||(clip==='completed'&&i>2);
  const concerned = clip==='blocked';
  const talk = clip==='talk'||clip==='phone';
  const glassWidth = r.glasses==='large'?34:31;
  const glassRx = r.glasses==='round'?15:r.glasses==='thin'?7:10;
  return group('head',
    ellipse(18,80,9,12,skin)+ellipse(110,80,9,12,skin)+
    line('M17 77 Q22 77 20 83','#D98E61',1.7)+line('M111 77 Q106 77 108 83','#D98E61',1.7)+
    path('M21 51 Q26 28 65 27 Q104 27 108 56 L106 84 Q100 106 65 111 Q30 108 23 87 Z',skin,'stroke="#C98A62" stroke-width="1.6"')+
    ellipse(34,92,7,3.8,'#F9A489','opacity=".36"')+ellipse(94,92,7,3.8,'#F9A489','opacity=".36"')+
    eye(44,80,blink,clip==='work'||clip==='review')+eye(84,80,blink,clip==='work'||clip==='review')+
    line(concerned?'M32 62 Q43 69 54 62 M73 62 Q84 69 96 62':'M33 63 Q43 59 54 62 M73 62 Q84 58 95 62','#372A26',4)+
    rect(27,67,glassWidth,27,'#DAE7F4',glassRx,'fill-opacity=".04" stroke="#17202C" stroke-width="4"')+
    rect(70,67,glassWidth,27,'#DAE7F4',glassRx,'fill-opacity=".04" stroke="#17202C" stroke-width="4"')+
    line('M58 74 Q64 71 70 74 M20 72 L27 73 M101 73 L109 71','#17202C',3.8)+
    line('M63 87 Q59 94 65 94','#D59870',1.5)+
    (concerned?line('M55 102 Q64 96 74 102','#965851',1.8):talk?ellipse(64,101,5,3+i%2,'#914D48'):line('M55 101 Q64 107 74 101','#A1584F',2))+
    hairFront());
}
function hairFront() {
  return group('hair',path('M19 70 Q11 57 17 45 L12 42 Q23 38 26 30 Q16 28 22 19 Q33 28 43 20 Q49 15 49 9 Q62 21 71 18 Q85 12 90 17 Q104 21 106 34 Q119 37 112 59 L109 69 Q100 61 100 49 Q94 53 88 45 Q71 55 61 42 Q48 59 30 53 Q28 65 19 70 Z','url(#hair)','stroke="#2F2426" stroke-width="2"')+
    path('M24 37 Q44 34 58 25 Q67 20 77 27 Q68 40 49 43 Q30 51 24 48 Z','#614133','opacity=".55"')+
    path('M51 20 Q63 22 69 31 Q75 40 72 44 Q86 38 83 29 Q75 21 63 20 Z','#78503A','opacity=".48"')+
    line('M29 32 Q43 34 54 26 M57 21 Q70 24 75 34 M90 25 Q99 31 100 41','#98705A',1.5));
}
function faceBack() {
  return group('head',ellipse(19,81,9,11,skin)+ellipse(109,81,9,11,skin)+
    path('M19 66 Q10 39 27 28 Q19 22 25 17 Q39 23 49 10 Q60 19 73 17 Q91 11 102 28 Q118 40 110 75 Q107 101 65 111 Q23 104 19 66 Z','url(#hair)','stroke="#2F2426" stroke-width="2"')+
    line('M29 35 Q47 47 60 31 M68 27 Q89 31 99 48 M24 63 Q39 67 52 80 M77 77 Q96 72 108 59 M43 94 Q63 103 82 91','#604536',3)+
    line('M20 77 L26 78 M101 78 L109 77','#17202C',3));
}
function faceSide(direction,clip,i) {
  // Independent silhouettes; never scale(-1,1), including asymmetric swept hair.
  const left = direction==='left';
  const blink = clip==='idle'&&i===2;
  const silhouette = left ? 'M84 41 Q48 30 30 53 L28 70 L17 82 Q17 86 27 87 L29 96 Q43 113 70 109 Q96 102 100 79 L98 55 Z' : 'M44 41 Q80 30 98 53 L100 70 L111 82 Q111 86 101 87 L99 96 Q85 113 58 109 Q32 102 28 79 L30 55 Z';
  const hair = left ? 'M29 64 Q16 47 30 30 L25 19 Q44 25 53 10 Q67 20 81 18 Q104 23 108 44 Q110 61 98 80 Q89 86 86 71 Q84 49 67 53 Q49 58 39 49 Z' : 'M99 64 Q112 47 98 30 Q104 23 95 18 Q83 25 71 11 Q57 19 45 18 Q24 23 20 43 Q18 62 30 80 Q38 85 42 71 Q44 49 59 53 Q76 56 88 47 Z';
  const eyeX=left?39:89;
  const earX=left?83:45;
  const glassesX=left?23:73;
  return group('head',path(silhouette,skin,'stroke="#C98A62" stroke-width="1.6"')+
    eye(eyeX,80,blink,clip==='review')+
    line(left?'M28 62 Q38 59 49 63':'M79 63 Q90 58 100 62','#372A26',4)+
    rect(glassesX,67,29,27,'#DAE7F4',radii(clip),'fill-opacity=".04" stroke="#17202C" stroke-width="4"')+
    line(left?'M52 74 L81 77':'M47 77 L73 74','#17202C',4)+
    ellipse(earX,81,9,11,skin)+line(left?'M82 77 Q88 76 87 84':'M46 77 Q40 76 41 84','#D98E61',1.5)+
    line(left?'M31 100 Q38 105 47 100':'M81 100 Q90 105 97 100','#A1584F',2)+
    path(hair,'url(#hair)','stroke="#2F2426" stroke-width="2"')+
    line(left?'M39 30 Q61 39 72 24 M81 27 Q96 35 98 48':'M30 32 Q47 35 58 25 M65 24 Q86 33 92 44','#98705A',1.5));
}
const radii = clip => clip==='blocked'?8:9;
function badge(x,y) {
  return group('badge',line(`M${x+4} ${y-7} L${x+4} ${y}`,'#EAC467',2)+rect(x,y,10,16,'#F1C40F',2,'stroke="#AA8236" stroke-width="1"')+rect(x+2,y+3,6,10,'#FFF8EF',1)+ellipse(x+5,y+6,1.8,2,'#3D6091')+path(`M${x+2.5} ${y+11} Q${x+5} ${y+7} ${x+7.5} ${y+11} Z`,'#3D6091'));
}
function prop(r,clip,facing,i) {
  if (['phone','think','blocked','completed','approve','work'].includes(clip)) return '';
  const back=facing==='back',side=facing==='left'||facing==='right';
  const x=back?85:facing==='left'?48:facing==='right'?71:21;
  const y=clip==='review'?111:122;
  const width=side?14:20;
  const angle=clip==='review'?n(-8+Math.sin(i)*3):facing==='left'?-5:facing==='right'?6:0;
  let body='';
  if(r.prop==='clipboard') body=rect(x,y,width,28,'#A06E49',2,'stroke="#4C362E" stroke-width="1.3"')+rect(x+2,y+3,width-4,22,'#FFF4DC',1)+rect(x+width/2-4,y-2,8,5,'#9DA8B6',1)+line(`M${x+5} ${y+10} L${x+width-4} ${y+10} M${x+5} ${y+16} L${x+width-4} ${y+16}`,'#9FAEC0',1.4);
  else if(r.prop==='laptop') body=rect(x,y,width,27,'#8292A7',2,'stroke="#324056" stroke-width="1.5"')+line(`M${x+2} ${y+25} L${x+width-2} ${y+25}`,'#BEC9D9',1.5)+ellipse(x+width/2,y+13,3,3,'#BFC9D5');
  else {
    body=rect(x,y,width,28,'#26364A',3,'stroke="#17202C" stroke-width="1.4"')+rect(x+2,y+3,width-4,21,'#D8E9F5',1);
    if(r.prop==='analytics') for(let b=0;b<3;b++)body+=rect(x+4+b*4,y+17-b*4,2,5+b*4,r.accent,.4);
    if(r.prop==='calculator') for(let b=0;b<6;b++)body+=rect(x+4+(b%2)*5,y+12+Math.floor(b/2)*4,3,2,'#427759',.5);
    body+=ellipse(x+width/2,y+26,1,1,'#90A9C5');
  }
  return group('prop',body,`rotate(${angle} ${x+width/2} ${y+14})`);
}
function arm(fromX,fromY,toX,toY,r) {
  const midX=(fromX+toX)/2+((toX>fromX)?4:-4);
  const midY=(fromY+toY)/2+4;
  return line(`M${fromX} ${fromY} Q${n(midX)} ${n(midY)} ${n(toX)} ${n(toY)}`,r.dark,13)+line(`M${fromX} ${fromY} Q${n(midX)} ${n(midY)} ${n(toX)} ${n(toY)}`,r.coat,10)+ellipse(toX,toY,5.3,6,skin,'stroke="#C98A62" stroke-width="1"');
}
function pose(r,clip,facing,i,total) {
  const phase=i/total*Math.PI*2, wave=Math.sin(phase), t=i/(total-1);
  const seated=clip==='work'?1:clip==='sit'?t:clip==='stand'?1-t:0;
  const lower=n(seated*16), bob=clip==='walk'?n(-Math.abs(wave)*1.6):clip==='idle'?n(Math.sin(phase)*.4):0;
  const side=facing==='left'||facing==='right';
  const back=facing==='back';
  const walk=clip==='walk'?wave*(side?6:2):0;
  const leftLift=clip==='walk'?n(Math.max(0,Math.cos(phase))*4):0;
  const rightLift=clip==='walk'?n(Math.max(0,-Math.cos(phase))*4):0;
  const feet=group('legs',
    path(`M${side?50:40} ${145+lower*.35} L${side?63:58} ${145+lower*.35} L${n((side?61:56)+walk)} ${161-leftLift} L${n((side?48:41)+walk)} ${161-leftLift} Z`,'#263346')+
    path(`M${side?64:69} ${145+lower*.35} L${side?77:86} ${145+lower*.35} L${n((side?80:88)-walk)} ${161-rightLift} L${n((side?64:70)-walk)} ${161-rightLift} Z`,'#263346')+
    rect((side?45:35)+walk,159-leftLift,side?19:24,6,'#332824',3,'stroke="#211D25" stroke-width="1"')+
    rect((side?64:69)-walk,159-rightLift,side?19:24,6,'#332824',3,'stroke="#211D25" stroke-width="1"'));
  let sleeves=arm(side?50:39,117,side?49:29,140+walk*.45,r)+arm(side?77:88,117,side?82:99,140-walk*.45,r);
  const torso=group('torso',path(side?'M48 112 Q62 105 79 112 L83 146 Q66 151 46 146 Z':'M36 114 Q43 108 64 108 Q87 108 92 115 L90 146 Q63 153 38 146 Z','url(#coat)','stroke="'+r.dark+'" stroke-width="1.8"')+
    (back?line('M64 116 L64 148',r.dark,1.5):side?path(facing==='left'?'M48 111 L55 114 L49 132 Z':'M79 111 L73 114 L79 132 Z','#F8FAFC')+badge(facing==='left'?46:74,123):path('M49 110 L64 128 L78 110 Z','#F8FAFC')+path('M60 113 L66 113 L69 119 L64 141 L59 121 Z',r.accent)+line('M47 111 L55 127 L48 133 M81 111 L73 127 L80 133',r.dark,2)+badge(78,122)));
  const head=back?faceBack():side?faceSide(facing,clip,i):faceFront(r,clip,i);
  let gestures='';
  const x=side?(facing==='left'?48:80):96, shoulder=side?75:88;
  if(clip==='phone') gestures=arm(shoulder,119,x,81+wave,r)+rect(x-3,70+wave,8,20,'#202D3E',2,'stroke="#5E6E80" stroke-width="1"');
  if(clip==='think') gestures=arm(shoulder,119,side?(facing==='left'?39:89):69,102+wave*.4,r);
  if(clip==='talk') gestures=arm(shoulder,119,x+4,110-wave*5,r);
  if(clip==='review') gestures=arm(side?50:39,119,side?53:32,126+wave*2,r);
  if(clip==='approve') gestures=arm(shoulder,119,x,111-Math.sin(t*Math.PI)*12,r)+path(`M${x-2} ${108-Math.sin(t*Math.PI)*12} L${x-2} ${101-Math.sin(t*Math.PI)*12} Q${x+1} ${98-Math.sin(t*Math.PI)*12} ${x+3} ${101-Math.sin(t*Math.PI)*12} L${x+3} ${110-Math.sin(t*Math.PI)*12} Z`,skin);
  if(clip==='completed') gestures=arm(side?50:39,119,side?45:25,120-Math.sin(t*Math.PI)*32,r)+arm(shoulder,119,x+3,119-Math.sin(t*Math.PI)*30,r);
  if(clip==='blocked') gestures=arm(side?50:39,119,side?47:22,76+wave*2,r)+arm(shoulder,119,side?81:105,76-wave*2,r);
  if(clip==='work') gestures=arm(side?50:39,119,side?54:49,134+wave*2,r)+arm(shoulder,119,side?74:78,134-wave*2,r)+group('work-laptop',path(side?'M36 129 L62 129 L67 143 L40 143 Z':'M42 128 L84 128 L90 144 L47 144 Z','#9AA8B8','stroke="#42516A" stroke-width="1.5"')+rect(side?38:45,143,side?35:47,3,'#52667D',1));
  return feet+group('rig-body',group('arms',sleeves)+torso+head+prop(r,clip,facing,i)+group('gesture',gestures),`translate(0 ${n(lower+bob)})`);
}
function svg(role,clip,facing,i) {
  const r=roles[role];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="176" viewBox="0 0 128 176" role="img" aria-label="${role} ${clip} ${facing} technical vector study frame ${i+1}"><title>Office Crew technical vector study — ${role} ${clip} ${facing} ${i+1}</title><desc>Original layered deterministic rig. Technical approximation only; not approved raster illustration. Separate independently drawn directions and original props. MIT.</desc>${defs(r)}${pose(r,clip,facing,i,clips[clip].frames)}</svg>\n`;
}
const assets=[];
let frameCount=0;
for(const [role] of Object.entries(roles)) {
  for(const [clip,timing] of Object.entries(clips)) for(const facing of facings) {
    const dir=`assets/characters/${role}/vector-study/${clip}-${facing}`;
    if(!checkOnly)mkdirSync(resolve(root,dir),{recursive:true});
    const frameFiles=[];
    const hashes=new Set();
    for(let i=0;i<timing.frames;i++) {
      const file=`${dir}/${String(i).padStart(2,'0')}.svg`;
      const artwork=svg(role,clip,facing,i);
      if(checkOnly)assert.equal(readFileSync(resolve(root,file),'utf8'),artwork,`Stale generated frame: ${file}`);
      else writeFileSync(resolve(root,file),artwork);
      // Remove frame labels so uniqueness is about drawing, not metadata.
      hashes.add(createHash('sha256').update(artwork.replace(/aria-label="[^"]*"/,'').replace(/<title>.*?<\/title>/,'')).digest('hex'));
      assert(!/scale\s*\(\s*-1/.test(artwork),'Mirrored facing is forbidden');
      frameFiles.push(file);frameCount++;
    }
    assert(hashes.size>1,`Clip does not animate: ${role} ${clip} ${facing}`);
    assets.push({id:`study.character.${role}.${clip}.${facing}`,kind:'character',role,clip,facing,file:frameFiles[0],frameFiles,mimeType:'image/svg+xml',status:'prototype',logicalSize:{width:64,height:88},anchor:{x:.5,y:.94},...timing,license:'MIT',provenance:'original-agent-viewer-technical-vector-rig',artFamily:'technical-vector-study',runtimeDefault:false,compatibleWithApprovedRaster:false});
  }
}
for(const role of Object.keys(roles)) {
  const file=`assets/characters/${role}/idle-front.png`;
  if(!existsSync(resolve(root,file)))continue;
  const provenanceFile=`assets/characters/${role}/source/provenance.json`;
  const data=existsSync(resolve(root,provenanceFile))?JSON.parse(readFileSync(resolve(root,provenanceFile),'utf8')):{};
  if(checkOnly && ['planner','developer','analyst'].includes(role)) {
    const png=readFileSync(resolve(root,file));
    assert.equal(png.readUInt32BE(16),256,`${role} runtime PNG width`);
    assert.equal(png.readUInt32BE(20),352,`${role} runtime PNG height`);
    assert.equal(data.styleReference,'assets/references/ceo-approved-concept.png',`${role} style provenance`);
    assert(existsSync(resolve(root,data.styleReference)),`${role} missing canonical reference`);
    assert(existsSync(resolve(root,data.sourceFile)),`${role} missing full-resolution original`);
    assert.equal(data.styleLock.family,'office-beans-approved-reference',`${role} raster style family`);
  }
  assets.push({id:`character.${role}.idle.front`,kind:'character',role,clip:'idle',facing:'front',file,mimeType:'image/png',status:'prototype',logicalSize:{width:64,height:88},anchor:{x:.5,y:.94},frames:1,fps:0,loop:false,license:'MIT',provenance:data.provenance||'original-agent-viewer-imagegen-reference-derived',artFamily:'office-beans-approved-reference',runtimeDefault:true,...(existsSync(resolve(root,provenanceFile))?{provenanceFile}:{})});
}
const catalog={schemaVersion:'1.0.0',project:'Agent Viewer Office Crew',coordinateSystem:{projection:'rectangular-2.5d',tileSize:48,logicalSpriteFrame:{width:64,height:88},facing:facings},notes:'Technical vector clips are motion studies only. Runtime uses approved-reference raster idle fronts; do not switch between the two art families.',assets};
if(checkOnly)assert.deepEqual(JSON.parse(readFileSync(resolve(root,'assets/characters/catalog.json'),'utf8')),catalog,'Catalog is stale. Run generator again.');
else writeFileSync(resolve(root,'assets/characters/catalog.json'),JSON.stringify(catalog,null,2)+'\n');
console.log(`${checkOnly?'Verified':'Generated'} ${frameCount} vector-study frames, ${assets.length} character entries. Preserved CEO legacy SVG and raster sources.`);
