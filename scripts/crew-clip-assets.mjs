import {existsSync, readFileSync, realpathSync, writeFileSync, renameSync, unlinkSync} from 'node:fs';
import {resolve, relative, sep} from 'node:path';
import {createHash} from 'node:crypto';
import {inflateSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const facings = ['front','right','back','left'];
const manifestPath = 'assets/crew/clips/manifest.v1.json';

/** Decodifica para inspección únicamente. Nunca modifica los PNG generados. */
export function decodeCrewPng(bytes) {
  requireValue(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])), 'PNG inválido');
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
  requireValue(bytes[24]===8 && bytes[25]===6 && bytes[28]===0, 'Se exige PNG RGBA 8 bits sin entrelazado');
  requireValue(width>0 && height>0 && width*height<=16_000_000, 'Dimensiones inválidas');
  const chunks=[];
  for(let offset=8;offset<bytes.length;) {
    const length=bytes.readUInt32BE(offset);
    requireValue(offset+length+12<=bytes.length,'PNG truncado');
    if(bytes.toString('ascii',offset+4,offset+8)==='IDAT') chunks.push(bytes.subarray(offset+8,offset+8+length));
    offset+=length+12;
  }
  const stride=width*4,raw=inflateSync(Buffer.concat(chunks),{maxOutputLength:(stride+1)*height});
  requireValue(raw.length===(stride+1)*height,'Datos PNG inválidos');
  const rgba=Buffer.alloc(stride*height);
  for(let y=0;y<height;y++) {
    const filter=raw[y*(stride+1)];requireValue(filter<=4,'Filtro PNG inválido');
    for(let x=0;x<stride;x++) {
      let value=raw[y*(stride+1)+1+x];
      const a=x>=4?rgba[y*stride+x-4]:0,b=y?rgba[(y-1)*stride+x]:0,c=y&&x>=4?rgba[(y-1)*stride+x-4]:0;
      if(filter===1) value+=a;
      if(filter===2) value+=b;
      if(filter===3) value+=Math.floor((a+b)/2);
      if(filter===4) {
        const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);
        value+=pa<=pb&&pa<=pc?a:pb<=pc?b:c;
      }
      rgba[y*stride+x]=value;
    }
  }
  return {width,height,rgba};
}

export function inspectCrewFrame(png,frame) {
  const rows=[];let transparent=0,opaque=0;
  for(let y=frame.y;y<frame.y+frame.height;y++) {
    const row=png.rgba.subarray((y*png.width+frame.x)*4,(y*png.width+frame.x+frame.width)*4);rows.push(row);
    for(let x=3;x<row.length;x+=4) { if(row[x]===0) transparent++;if(row[x]>200) opaque++; }
  }
  return {rgbaSha256:sha256(Buffer.concat(rows)),transparent,opaque};
}

function safeFile(root,path,prefix) {
  requireValue(typeof path==='string' && path.startsWith(prefix) && !path.includes('..') && !path.includes('\\'), 'Ruta inválida');
  const absolute=realpathSync(resolve(root,path));
  requireValue(!relative(realpathSync(root),absolute).startsWith(`..${sep}`),'Ruta fuera del repositorio');
  return readFileSync(absolute);
}

/** El catálogo nunca autoriza arte por sí mismo: la importación solo admite prototype. */
export function validateCrewWalkManifest(root,manifest=JSON.parse(readFileSync(resolve(root,manifestPath),'utf8'))) {
  requireValue(manifest.schemaVersion===1 && Array.isArray(manifest.clips),'Versión de manifiesto inválida');
  requireValue(manifest.clips.length===4 && new Set(manifest.clips.map(clip=>clip.facing)).size===4,'Se exige exactamente un clip por orientación');
  const ids=new Set(),files=new Set(),hashes=new Set();
  for(const clip of manifest.clips) {
    requireValue(clip.role==='ceo' && clip.variant==='default' && clip.clip==='walk' && facings.includes(clip.facing),'Identidad de clip inválida');
    requireValue(clip.id===`ceo.walk.${clip.facing}.v${clip.version}` && Number.isInteger(clip.version) && clip.version>0,'ID/version inválido');
    requireValue(!ids.has(clip.id) && !files.has(clip.file) && !hashes.has(clip.sha256),'Clip duplicado');
    ids.add(clip.id);files.add(clip.file);hashes.add(clip.sha256);
    requireValue(clip.status==='prototype','El importador no aprueba arte automáticamente');
    requireValue(clip.license==='MIT' && clip.provenance?.tool==='image_gen built-in' && typeof clip.provenance.sourceCommit==='string','Procedencia/licencia inválida');
    const prompt=safeFile(root,clip.provenance.promptFile,'assets/crew/origins/');
    requireValue(sha256(prompt)===clip.provenance.promptSha256,'Hash del prompt diferente');
    const bytes=safeFile(root,clip.file,'assets/crew/clips/');
    requireValue(sha256(bytes)===clip.sha256,'Hash del atlas diferente');
    const png=decodeCrewPng(bytes);
    requireValue(png.width===clip.width && png.height===clip.height,'Dimensiones diferentes');
    requireValue(clip.resolution?.width===256 && clip.resolution.height===352 && clip.anchor?.x===.5 && clip.anchor.y===.9375,'Contrato lógico inválido');
    requireValue(Number.isFinite(clip.fps) && clip.fps>0 && clip.loop===true && clip.frames.length>=6,'Se exige caminar con 6+ fotogramas');
    requireValue(clip.review?.status==='prototype-reviewed' && typeof clip.review.notes==='string' && clip.review.notes.length>0,'Falta revisión visual de prototipo');
    const frames=new Set();
    for(const frame of clip.frames) {
      requireValue([frame.x,frame.y,frame.width,frame.height].every(Number.isInteger) && frame.x>=0 && frame.y>=0 && frame.width>0 && frame.height>0 && frame.x+frame.width<=png.width && frame.y+frame.height<=png.height,'Rectángulo fuera del atlas');
      requireValue(Number.isFinite(frame.anchor?.x) && Number.isFinite(frame.anchor?.y) && frame.anchor.x>=0 && frame.anchor.x<=frame.width && frame.anchor.y>=0 && frame.anchor.y<=frame.height && Number.isFinite(frame.durationMs) && frame.durationMs>0,'Anclaje/duración inválido');
      const inspection=inspectCrewFrame(png,frame);
      requireValue(inspection.transparent>0 && inspection.opaque>100,'El fotograma necesita transparencia real y personaje');
      requireValue(inspection.rgbaSha256===frame.rgbaSha256,'Hash de fotograma diferente');
      requireValue(!frames.has(inspection.rgbaSha256),'Fotograma duplicado');frames.add(inspection.rgbaSha256);
    }
  }
  return {clips:manifest.clips.length,frames:manifest.clips.reduce((sum,clip)=>sum+clip.frames.length,0)};
}

export function importCrewWalkManifest(root,candidate) {
  const prototype={...candidate,clips:candidate.clips.map(clip=>({...clip,status:'prototype'}))};
  validateCrewWalkManifest(root,prototype);
  const target=resolve(root,manifestPath);
  if(existsSync(target)) {
    const existing=JSON.parse(readFileSync(target,'utf8'));
    requireValue(JSON.stringify(existing)===JSON.stringify(prototype),'El catálogo existente difiere; no se reemplaza durante importación');
  }
  return prototype;
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const root=fileURLToPath(new URL('../',import.meta.url));
  if(process.argv[2]==='import') {
    requireValue(process.argv[3],'Falta manifiesto candidato');
    const candidate=JSON.parse(readFileSync(resolve(process.argv[3]),'utf8'));
    const prototype=importCrewWalkManifest(root,candidate),target=resolve(root,manifestPath),temporary=`${target}.${process.pid}.tmp`;
    try {writeFileSync(temporary,JSON.stringify(prototype,null,2)+'\n',{flag:'wx'});renameSync(temporary,target);}
    finally {if(existsSync(temporary)) unlinkSync(temporary);}
  }
  console.log(JSON.stringify(validateCrewWalkManifest(root)));
}
