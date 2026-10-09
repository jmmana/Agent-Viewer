#!/usr/bin/env node
/**
 * Deterministic original Agent Viewer office artwork. No external assets/fonts.
 * Run: node scripts/generate-office-environment.mjs
 * SVG geometry, logical sizes and screen rectangles share logical pixel units.
 * Footprints and interaction points are relative to the object's ground anchor.
 * These are renderable MIT vector prototypes, not approved production artwork.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ink = '#334155', pale = '#E2E8F0', wood = '#CFA780', navy = '#1E3A8A';
const assets = [];
const r = (x,y,w,h,fill,rx=4,stroke=ink) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="1.8"` : ''}/>`;
const p = (d,fill,stroke=ink,width=1.8) => `<path d="${d}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"` : ''}/>`;
const c = (x,y,radius,fill,stroke=ink) => `<circle cx="${x}" cy="${y}" r="${radius}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="1.8"` : ''}/>`;
const e = (x,y,rx,ry,fill,stroke=null) => `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="1.8"` : ''}/>`;
const line = (x1,y1,x2,y2,color=ink,width=2) => `<path d="M${x1} ${y1}L${x2} ${y2}" stroke="${color}" stroke-width="${width}" stroke-linecap="round" fill="none"/>`;
const shadow = (x,y,rx,ry) => e(x,y,rx,ry,'#0F172A') .replace('fill="#0F172A"', 'fill="#0F172A" opacity="0.09"');
const screen = (x,y,w,h) => r(x,y,w,h,'#132A43',2,'#64748B');

function asset(kind,name,w,h,body,options={}) {
  const anchor = options.anchor ?? { x:0.5, y:0.93 };
  const folder = `assets/${kind}`;
  const file = `${folder}/${name}.svg`;
  mkdirSync(resolve(root,folder),{recursive:true});
  writeFileSync(resolve(root,file), `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><title>Agent Viewer ${name.replaceAll('-',' ')}</title><g stroke-linejoin="round">${body}</g></svg>\n`);
  const record = {id:`${kind === 'electronics' ? 'electronics' : kind === 'effects' ? 'effect' : 'furniture'}.${name}`,kind:kind === 'effects' ? 'effect' : kind === 'electronics' ? 'electronics' : 'furniture',file,mimeType:'image/svg+xml',status:'prototype',logicalSize:{width:w,height:h},anchor,frames:1,fps:0,loop:false,license:'MIT',provenance:'original-agent-viewer-vector-prototype',...options};
  assets.push(record);
  return record;
}
const solid = (w,d) => ({footprint:{x:-w/2,y:-d/2,width:w,height:d}});
const interaction = (x,y,action) => ({x,y,action});

// Furniture. Front-facing rectangular ground geometry, with shallow top planes.
function desk(name,width,executive=false) {
  const w=width, h=100;
  return asset('furniture',name,w,h,
    shadow(w/2,91,w/2-8,6)+r(14,40,9,48,'#64748B',2)+r(w-23,40,9,48,'#64748B',2)+
    r(8,29,w-16,18,executive?'#A67C55':wood,5)+p(`M8 29L20 15H${w-20}L${w-8} 29Z`,executive?'#E4C6A3':'#E9CDB0')+
    r(w-48,45,31,39,'#CBD5E1',3)+line(w-44,58,w-21,58,'#94A3B8')+line(w-38,51,w-30,51)+line(w-38,70,w-30,70)+
    (executive ? line(24,34,w-60,34,'#F1C40F',2) : ''),
    {...solid(w-24,34),surfaceRect:{x:21,y:16,width:w-42,height:13},interactionPoints:[interaction(0,39,'work')],theme:executive?'executive':'workspace'});
}
desk('desk-workstation',144);
desk('desk-executive',168,true);
function chair(name,color,executive=false) {
  asset('furniture',name,64,94,shadow(32,86,24,5)+
    r(15,executive?6:14,34,45,color,12)+r(19,executive?12:20,26,29,executive?'#334155':'#64748B',8,null)+
    line(12,48,12,65,ink,4)+line(52,48,52,65,ink,4)+r(10,46,11,5,'#64748B',2)+r(43,46,11,5,'#64748B',2)+
    r(12,57,40,13,color,7)+line(32,70,32,83,ink,5)+line(32,81,12,85)+line(32,81,52,85)+line(32,81,32,88)+
    c(12,86,3,'#64748B')+c(52,86,3,'#64748B')+c(32,88,3,'#64748B'),
    {...solid(36,24),seatPoint:{x:0,y:-19},interactionPoints:[interaction(0,21,'sit')]});
}
chair('chair-ergonomic','#475569');
chair('chair-executive',navy,true);
asset('furniture','meeting-table',224,130,shadow(112,118,90,7)+r(40,63,12,47,'#64748B',3)+r(173,63,12,47,'#64748B',3)+
  r(10,20,204,67,wood,25)+r(10,12,204,60,'#E9CDB0',25)+line(37,24,187,24,'#F8EAD8',2),
  {...solid(190,72),surfaceRect:{x:29,y:23,width:166,height:42},interactionPoints:[interaction(-80,55,'meet'),interaction(0,55,'meet'),interaction(80,55,'meet'),interaction(-80,-58,'meet'),interaction(0,-58,'meet'),interaction(80,-58,'meet')]});
asset('furniture','sofa-lounge',156,98,shadow(78,88,65,6)+r(22,64,7,24,'#64748B',2)+r(126,64,7,24,'#64748B',2)+
  r(11,18,134,48,'#0D9488',15)+r(18,27,57,35,'#5FBDB2',9)+r(81,27,57,35,'#5FBDB2',9)+
  r(16,55,124,21,'#2CA99C',10)+r(7,40,20,38,'#0D9488',9)+r(129,40,20,38,'#0D9488',9),
  {...solid(132,35),interactionPoints:[interaction(-32,33,'rest'),interaction(32,33,'rest')]});
asset('furniture','coffee-table',98,64,shadow(49,56,40,4)+r(15,27,7,27,'#64748B',2)+r(76,27,7,27,'#64748B',2)+r(6,14,86,20,wood,10)+r(6,9,86,17,'#E9CDB0',10),
  {...solid(74,24),surfaceRect:{x:17,y:10,width:64,height:13}});
function plant(name,small=false) {
  const scale=small?0.58:1, w=small?42:72, h=small?58:102;
  asset('furniture',name,w,h, `<g transform="scale(${scale})">`+shadow(36,94,23,5)+
    p('M25 61H49L45 91H29Z','#E4AE81')+e(36,61,12,4,'#8B6549',ink)+
    line(36,66,36,21,'#166534',3)+p('M35 43C13 47 9 29 14 25C29 23 35 33 35 43Z','#16A34A')+
    p('M37 33C57 33 63 15 58 11C42 12 37 21 37 33Z','#0D9488')+
    p('M36 57C55 59 65 44 60 37C46 38 36 49 36 57Z','#22A86E')+
    p('M34 28C20 25 19 10 24 7C35 8 39 19 34 28Z','#4CB88D')+'</g>',
    {...solid(small?22:34,small?14:22),decorative:true});
}
plant('plant-floor'); plant('plant-desk',true);
asset('furniture','bookshelf',98,138,shadow(49,129,41,5)+r(8,8,82,117,'#A67C55',5)+r(14,14,70,101,'#EBD5BC',2)+
  [42,78,114].map(y=>r(12,y,74,5,'#A67C55',1)).join('')+
  [[20,17,8,24,navy],[31,21,7,20,'#0D9488'],[41,18,10,23,'#7C3AED'],[56,24,18,17,'#CBD5E1'],[21,52,22,24,'#D7AB7C'],[52,50,8,26,'#2563EB'],[64,57,10,19,'#EA580C'],[19,90,9,22,'#166534'],[32,86,10,26,navy],[53,97,23,15,'#94A3B8']].map(([x,y,w,h,color])=>r(x,y,w,h,color,1)).join('')+
  r(15,124,7,6,'#64748B',1)+r(76,124,7,6,'#64748B',1),{...solid(76,25)});
asset('furniture','filing-cabinet',66,96,shadow(33,88,26,5)+r(9,10,48,75,'#94A3B8',5)+
  [15,38,61].map(y=>r(13,y,40,20,pale,3)+r(25,y+5,16,5,'#CBD5E1',1)+line(26,y+14,40,y+14)).join(''),
  {...solid(44,28),interactionPoints:[interaction(0,26,'files')]});
asset('furniture','desk-lamp',58,70,shadow(29,62,23,4)+e(29,59,20,6,'#94A3B8',ink)+line(29,55,19,33,ink,4)+line(19,33,34,16,ink,4)+
  c(19,33,3,'#CBD5E1')+p('M32 10L49 21L44 30L24 17Z','#F1C40F')+line(27,18,43,28,'#FFE697',2),{decorative:true});
asset('furniture','whiteboard',150,130,shadow(75,119,56,5)+line(37,78,26,119,'#64748B',4)+line(111,78,122,119,'#64748B',4)+
  r(8,10,134,76,'#94A3B8',5)+r(14,16,122,62,'#F8FAFC',2)+r(33,83,86,5,'#64748B',2)+r(109,80,10,4,'#2563EB',1),
  {...solid(112,24),screenRect:{x:15,y:17,width:120,height:60},interactionPoints:[interaction(0,35,'present')]});
asset('furniture','kanban-board',150,116,shadow(75,106,58,5)+line(29,80,25,107,'#64748B',4)+line(121,80,125,107,'#64748B',4)+
  r(7,8,136,79,'#94A3B8',5)+r(13,14,124,65,'#F8FAFC',2)+
  [18,59,100].map((x,i)=>r(x,20,31,7,['#7C3AED','#2563EB','#0D9488'][i],2,null)+[34,51,68].map((y,j)=>r(x,y,31,j===2?5:12,['#EDE9FE','#DBEAFE','#CCFBF1'][i],2,null)).join('')).join(''),
  {...solid(112,23),decorative:true,interactionPoints:[interaction(0,32,'plan')]});
asset('furniture','coffee-bar',154,104,shadow(77,96,65,5)+r(13,31,128,62,'#A67C55',4)+r(8,20,138,17,'#475569',5)+
  p('M8 20L19 10H135L146 20Z','#CBD5E1')+r(22,44,48,40,'#CFA780',3)+r(83,44,48,40,'#CFA780',3)+line(62,53,62,70)+line(91,53,91,70),
  {...solid(128,34),surfaceRect:{x:20,y:12,width:113,height:8},interactionPoints:[interaction(0,38,'coffee')]});
asset('furniture','stool',44,70,shadow(22,62,18,4)+line(14,29,9,62,'#64748B',4)+line(30,29,35,62,'#64748B',4)+line(12,49,32,49,'#64748B',3)+
  e(22,26,18,7,'#0D9488',ink)+e(22,21,18,6,'#5FBDB2',ink),{...solid(30,20),interactionPoints:[interaction(0,22,'sit')]});
asset('furniture','coffee-cup',34,36,shadow(17,31,12,3)+p('M24 11C37 7 37 25 25 24','none',ink,3)+r(7,8,20,21,'#F8FAFC',5)+e(17,9,10,3,'#D1AA82',ink)+
  p('M12 6C9 3 15 2 13 0M20 6C17 3 23 2 21 0','none','#94A3B8',1.3),{decorative:true,anchor:{x:0.5,y:0.84},attachPoint:{x:17,y:19}});
asset('furniture','clipboard',36,46,r(5,6,26,36,'#B98961',4)+r(8,10,20,28,'#F8FAFC',2)+r(12,3,12,7,'#64748B',2)+[19,25,31].map(y=>line(12,y,24,y,'#94A3B8',1.4)).join(''),{decorative:true,anchor:{x:0.5,y:0.9}});
asset('furniture','headphones',44,42,p('M9 27V19C9 1 35 1 35 19V27','none',ink,5)+r(5,23,10,15,'#2563EB',4)+r(29,23,10,15,'#2563EB',4),{decorative:true});
asset('furniture','document-folder',46,38,p('M4 10V6H18L22 10H42V32H4Z','#D1AE84')+p('M4 14H42L39 32H7Z','#F3D3A6')+r(11,5,24,16,'#F8FAFC',1)+line(16,9,29,9,'#94A3B8',1.3)+p('M4 14H42L39 32H7Z','#F3D3A6'),{decorative:true});

// Electronics: blank compositing regions are populated by runtime data only.
asset('electronics','monitor',78,74,shadow(39,67,26,4)+r(34,46,10,16,'#64748B',2)+e(39,63,24,5,'#94A3B8',ink)+
  r(5,6,68,44,ink,5)+screen(10,11,58,32)+c(39,47,1,'#22D3EE',null),
  {screenRect:{x:10,y:11,width:58,height:32},...solid(42,14),surfaceMounted:true});
asset('electronics','dual-monitor',136,76,shadow(68,68,47,4)+line(68,47,68,62,'#64748B',5)+line(35,40,100,40,'#64748B',4)+e(68,64,26,5,'#94A3B8',ink)+
  r(3,7,63,42,ink,4)+r(70,7,63,42,ink,4)+screen(8,12,53,31)+screen(75,12,53,31),
  {screenRects:[{x:8,y:12,width:53,height:31},{x:75,y:12,width:53,height:31}],...solid(45,14),surfaceMounted:true});
asset('electronics','laptop',78,64,shadow(39,57,33,4)+r(10,6,58,36,ink,4)+screen(15,11,48,26)+
  p('M10 42H68L75 53Q77 57 72 57H6Q1 57 3 53Z','#CBD5E1')+r(21,43,36,5,'#94A3B8',1,null)+r(30,50,18,4,'#E2E8F0',1,null),
  {screenRect:{x:15,y:11,width:48,height:26},...solid(65,18),surfaceMounted:true});
asset('electronics','tv-display',164,102,shadow(82,94,52,4)+r(75,73,14,18,'#64748B',3)+e(82,91,41,4,'#94A3B8',ink)+
  r(6,7,152,75,ink,7)+screen(13,14,138,60)+c(149,78,1.4,'#22D3EE',null),
  {screenRect:{x:13,y:14,width:138,height:60},...solid(76,16),surfaceMounted:true});
asset('electronics','office-phone',64,50,shadow(32,43,27,4)+p('M10 16H52L59 38Q59 42 54 42H8Q3 42 5 37Z','#64748B')+
  r(21,20,22,10,'#132A43',2)+p('M10 13Q7 8 12 6H48Q54 8 52 13L45 18H37V13H24V18H16Z',ink)+
  [27,34,41].map(x=>[33,37].map(y=>r(x,y,3,2,'#CBD5E1',0,null)).join('')).join(''),
  {screenRect:{x:22,y:21,width:20,height:8},surfaceMounted:true,...solid(48,20),interactionPoints:[interaction(0,22,'call')]});
asset('electronics','conference-camera',60,34,shadow(30,29,22,3)+r(22,19,16,8,'#94A3B8',3)+r(5,7,50,15,ink,7)+c(30,14,6,'#2563EB')+c(30,14,2,'#22D3EE',null)+c(47,14,1.5,'#16A34A',null),{surfaceMounted:true,...solid(42,12)});
asset('electronics','speakerphone',58,37,shadow(29,31,24,4)+p('M18 7H40L53 26Q55 31 47 31H11Q3 31 5 26Z','#475569')+
  e(29,18,13,7,'#334155')+[-6,0,6].map(dx=>line(23+dx,15,23+dx,21,'#64748B',1)).join('')+c(18,26,2,'#22D3EE',null)+c(39,26,2,'#16A34A',null),{surfaceMounted:true,...solid(43,20)});
asset('electronics','coffee-machine',64,82,shadow(32,75,26,4)+r(9,8,46,65,'#475569',6)+r(14,15,36,16,'#64748B',3)+r(17,37,30,25,'#1E293B',3)+
  r(25,33,14,7,'#94A3B8',2)+r(24,48,17,15,'#F8FAFC',4)+p('M41 51C51 48 51 62 41 60','none','#F8FAFC',2)+r(13,64,38,6,'#94A3B8',2)+c(44,23,3,'#22D3EE',null),
  {surfaceMounted:true,...solid(44,24),interactionPoints:[interaction(0,28,'coffee')]});
asset('electronics','water-dispenser',56,108,shadow(28,99,21,4)+r(9,35,38,61,'#CBD5E1',5)+r(15,8,26,33,'#A5DEF2',8)+
  r(18,6,20,5,'#2563EB',2)+r(15,48,26,27,'#64748B',3)+r(19,50,5,7,'#2563EB',1)+r(32,50,5,7,'#EA580C',1)+r(17,73,22,4,'#94A3B8',2)+line(15,86,41,86,'#94A3B8',2),
  {...solid(34,25),interactionPoints:[interaction(0,28,'water')]});
asset('electronics','router',64,50,shadow(32,44,25,4)+line(15,24,9,6,ink,3)+line(49,24,55,6,ink,3)+r(7,25,50,17,'#475569',5)+
  p('M7 25L15 18H50L57 25Z','#94A3B8')+[17,24,31].map(x=>c(x,34,1.5,'#22D3EE',null)).join('')+line(42,33,50,33,'#94A3B8',1),{surfaceMounted:true,...solid(43,18)});
asset('electronics','tablet',42,56,r(5,4,32,46,ink,5)+screen(9,9,24,33)+c(21,46,1.8,'#94A3B8',null),{screenRect:{x:9,y:9,width:24,height:33},decorative:true,anchor:{x:0.5,y:0.89}});
asset('electronics','smartphone',28,46,r(4,3,20,38,ink,5)+screen(7,9,14,24)+line(12,6,16,6,'#94A3B8',1)+c(14,37,1.2,'#94A3B8',null),{screenRect:{x:7,y:9,width:14,height:24},decorative:true});
asset('electronics','calculator',34,46,r(5,4,24,37,'#475569',4)+screen(9,9,16,9)+[10,16,22].map(x=>[24,30,36].map(y=>r(x-1,y-2,4,3,x===22?'#0D9488':'#CBD5E1',1,null)).join('')).join(''),{screenRect:{x:9,y:9,width:16,height:9},decorative:true});

// Static state glyphs. The renderer controls opacity, pulses and reduced motion.
const badge = body => c(20,20,17,'#F8FAFC','#CBD5E1')+body;
const effectOptions = {anchor:{x:0.5,y:0.5},decorative:true,compositing:'runtime-state-overlay'};
asset('effects','wifi',40,40,badge(p('M9 18Q20 7 31 18M13 23Q20 16 27 23M17 27Q20 24 23 27','none','#0D9488',2.5)+c(20,31,1.7,'#0D9488',null)),effectOptions);
asset('effects','call',40,40,badge(p('M13 10L18 15L15 19Q18 24 23 26L27 23L32 28Q26 36 16 27Q7 18 13 10Z','#2563EB',null)),effectOptions);
asset('effects','check',40,40,badge(p('M11 20L17 26L30 13','none','#16A34A',3.5)),effectOptions);
asset('effects','blocked',40,40,badge(c(20,20,10,'none','#EA580C')+line(13,13,27,27,'#EA580C',3)),effectOptions);
asset('effects','tool',40,40,badge(p('M12 9Q18 7 20 12L17 16L21 20L26 16Q32 20 29 25L25 26L16 17L12 18Q7 14 12 9Z','#64748B')+line(20,21,12,29,'#2563EB',4)),effectOptions);
asset('effects','thought',40,40,badge(c(12,20,2.2,'#7C3AED',null)+c(20,20,2.2,'#7C3AED',null)+c(28,20,2.2,'#7C3AED',null)),effectOptions);
asset('effects','alert',40,40,badge(p('M20 9L32 30H8Z','#F1C40F')+line(20,16,20,22,ink,2.5)+c(20,26,1.4,ink,null)),effectOptions);
asset('effects','sync',40,40,badge(p('M11 20A9 9 0 0 1 28 15L28 9M28 15H22M29 20A9 9 0 0 1 12 25V31M12 25H18','none','#0D9488',2.5)),effectOptions);
asset('effects','terminal',40,40,badge(r(8,11,24,18,navy,3)+p('M13 16L17 20L13 24','none','#22D3EE',2)+line(20,24,27,24,'#F8FAFC',2)),effectOptions);

const place = (id,x,y,extra={}) => ({assetId:id,x,y,...extra});
const f = name=>`furniture.${name}`, t=name=>`electronics.${name}`;
const layouts = [
  {id:'director-suite',size:{width:576,height:384},placements:[
    place(f('desk-executive'),280,202),place(f('chair-executive'),280,126),
    place(t('laptop'),272,125,{supportAssetId:f('desk-executive')}),place(t('office-phone'),333,135,{supportAssetId:f('desk-executive')}),
    place(f('bookshelf'),75,135),place(f('plant-floor'),490,124),place(t('tv-display'),446,255),place(f('sofa-lounge'),115,304)
  ],spawnPoints:[{x:288,y:336}],doorways:[{x:264,y:384,width:72}],interactionZones:[{x:280,y:241,action:'work'},{x:446,y:285,action:'present'}]},
  {id:'meeting-room',size:{width:672,height:432},placements:[
    place(f('meeting-table'),336,240),place(t('speakerphone'),336,191,{supportAssetId:f('meeting-table')}),
    place(t('tv-display'),336,105),place(t('conference-camera'),336,39,{supportAssetId:t('tv-display')}),
    ...[258,336,414].flatMap(x=>[place(f('chair-ergonomic'),x,158),place(f('chair-ergonomic'),x,311)]),
    place(f('whiteboard'),567,203),place(f('plant-floor'),78,124)
  ],spawnPoints:[{x:120,y:360},{x:480,y:360}],doorways:[{x:84,y:432,width:72},{x:516,y:432,width:72}],interactionZones:[{x:258,y:294,action:'meet'},{x:336,y:294,action:'meet'},{x:414,y:294,action:'meet'},{x:258,y:140,action:'meet'},{x:336,y:140,action:'meet'},{x:414,y:140,action:'meet'},{x:567,y:238,action:'present'}]},
  {id:'coffee-area',size:{width:576,height:384},placements:[
    place(f('coffee-bar'),148,147),place(t('coffee-machine'),112,68,{supportAssetId:f('coffee-bar')}),place(t('router'),183,67,{supportAssetId:f('coffee-bar')}),
    place(t('water-dispenser'),55,246),place(f('sofa-lounge'),350,259),place(f('coffee-table'),350,313),
    place(f('coffee-cup'),329,268,{supportAssetId:f('coffee-table')}),place(t('tv-display'),402,109),place(f('plant-floor'),496,293)
  ],spawnPoints:[{x:240,y:336}],doorways:[{x:204,y:384,width:72}],interactionZones:[{x:148,y:185,action:'coffee'},{x:55,y:274,action:'water'},{x:350,y:292,action:'rest'}]}
];
for (const layout of layouts) {
  const folder = `assets/rooms/${layout.id}`;
  mkdirSync(resolve(root,folder),{recursive:true});
  const placements = layout.placements.map((placement,index)=>({id:`${layout.id}.${index+1}`,...placement}));
  for (const placement of placements) {
    if (placement.supportAssetId) placement.supportPlacementId = placements.find(p=>p.assetId===placement.supportAssetId && !p.supportAssetId)?.id;
  }
  const data = {schemaVersion:'1.0.0',status:'prototype',coordinateSystem:'rectangular-ground-pixels',tileSize:48,placementAnchor:'asset.anchor',collisionRule:'Use asset footprint offset from placement x/y; surface-mounted children and decorative props do not block navigation.',depthRule:'Sort root placements by ground y; draw each supportPlacementId child immediately after its supporting object, keeping its own x/y placement.',provenance:'original-agent-viewer-layout-prototype',license:'MIT',...layout,placements};
  writeFileSync(resolve(root,folder,'layout.json'),JSON.stringify(data,null,2)+'\n');
}
const catalog = {schemaVersion:'1.0.0',project:'Agent Viewer Office Crew',coordinateSystem:{projection:'rectangular-2.5d',tileSize:48},geometryContract:{units:'logical pixels',anchor:'normalized fraction of logicalSize',footprint:'ground rectangle relative to anchor, not artwork bounds',screenRect:'source-local rectangle; render live content after artwork at the same transform',screenRects:'ordered source-local rectangles for multiple displays',surfaceRect:'source-local decorative compositing region',interactionPoints:'ground points relative to anchor',surfaceMounted:'ignore ground footprint when attached to supporting furniture',decorative:'does not block ground navigation'},assets,layouts:layouts.map(layout=>({id:layout.id,file:`assets/rooms/${layout.id}/layout.json`}))};
writeFileSync(resolve(root,'assets/furniture/catalog.json'),JSON.stringify(catalog,null,2)+'\n');
console.log(`Generated ${assets.length} original SVG prototypes and ${layouts.length} optional room layouts.`);
