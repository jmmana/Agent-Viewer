import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, Coffee, GalleryVerticalEnd, Pause, Play, RotateCcw, Sparkles, Users, VolumeX } from 'lucide-react';
import { assetUrls, CYCLE_SECONDS, findCharacter, roles, sceneAt, scenes, studioAssets } from './assets';
import { drawScene, loadStudioImages, sceneViews } from './scene';
import './visual-studio.css';

export default function VisualStudio() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const images = useRef(new Map<string, HTMLImageElement>());
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string[]>([]);
  const [playing, setPlaying] = useState(true);
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [role, setRole] = useState('ceo');
  const [clip, setClip] = useState('idle');
  const [facing, setFacing] = useState('front');
  const [seconds, setSeconds] = useState(0);
  const [galleryKind, setGalleryKind] = useState('character');
  const [view, setView] = useState<keyof typeof sceneViews>('all');
  const currentTime = useRef(0);
  const selection = findCharacter(role, clip, facing);
  const currentScene = sceneAt(seconds);
  const activeRole = roles.find(entry => entry.id === role)!;
  const available = studioAssets.filter(asset => asset.kind === 'character' && asset.role === role);
  const gallery = studioAssets.filter(asset => asset.kind === galleryKind);

  useEffect(() => {
    let cancelled = false;
    loadStudioImages().then(result => {
      if (cancelled) return;
      images.current = result.cache;
      setFailed(result.failed);
      setReady(true);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handleChange = () => setReduced(query.matches);
    query.addEventListener('change', handleChange);
    return () => query.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    let frame = 0;
    let previous = 0;
    let lastUi = -1;
    const animate = (now: number) => {
      if (previous && playing && !reduced) currentTime.current = (currentTime.current + Math.min((now - previous) / 1000, .08)) % CYCLE_SECONDS;
      previous = now;
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (ctx && canvas) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const framing = sceneViews[view];
        const width = Math.round(framing.width * dpr);
        const height = Math.round(framing.height * dpr);
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.translate(-framing.x, -framing.y);
        drawScene(ctx, images.current, currentTime.current, reduced, role);
      }
      const ui = Math.floor(currentTime.current * 4);
      if (ui !== lastUi) { lastUi = ui; setSeconds(currentTime.current); }
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [playing, reduced, role, ready, view]);

  function seek(time: number) { currentTime.current = time; setSeconds(time); }
  function chooseRole(id: string) { setRole(id); setClip('idle'); setFacing('front'); }

  return (
    <main className="vs-root">
      <div className="vs-shell">
        <header className="vs-header">
          <a className="vs-back" href={window.location.pathname} aria-label="Volver a Agent Viewer"><ArrowLeft size={17} /><span>Agent Viewer</span></a>
          <span className="vs-badge"><span />ESTUDIO VISUAL · SIMULADO</span>
          <span className="vs-credit">Office Crew / 01</span>
        </header>

        <section className="vs-intro" aria-labelledby="vs-title">
          <div><p className="vs-eyebrow"><Sparkles size={14} />EL EQUIPO COBRA VIDA</p><h1 id="vs-title">Una oficina, seis personalidades.</h1><p>Explora los personajes y sus espacios. El director trabaja, llama, se reúne y toma una pausa de café.</p></div>
          <div className="vs-intro-meta"><span><Users size={17} />6 roles</span><span><Coffee size={17} />3 espacios</span><span><VolumeX size={17} />Sin audio</span></div>
        </section>

        <div className="vs-workspace">
          <section className="vs-scene-card" aria-label="Escena de oficina simulada">
            <div className="vs-scene-toolbar"><div><span className="vs-indicator" /><strong>{currentScene.label}</strong><span className="vs-time">{Math.floor(seconds).toString().padStart(2, '0')} / 44 s</span></div><span className="vs-tag">DATOS FICTICIOS</span></div>
            <div className="vs-canvas-wrap" aria-busy={!ready}>
              <canvas ref={canvasRef} style={{ aspectRatio: `${sceneViews[view].width}/${sceneViews[view].height}` }} role="img" aria-label="Oficina ilustrativa con dirección, sala de reuniones y café. El director circula por los espacios; cinco compañeros muestran los otros roles. Las pantallas muestran noticias ficticias.">Oficina simulada. Usa los controles de escena para explorar las actividades.</canvas>
              {!ready && <div className="vs-loading">Preparando recursos visuales…</div>}
            </div>
            <div className="vs-controls">
              <button type="button" className="vs-play" onClick={() => setPlaying(value => !value)} disabled={reduced} aria-label={playing ? 'Pausar escena' : 'Reproducir escena'}>{playing && !reduced ? <Pause size={16} /> : <Play size={16} />}{playing && !reduced ? 'Pausar' : 'Reproducir'}</button>
              <button type="button" className="vs-reset" onClick={() => seek(0)}><RotateCcw size={15} />Reiniciar</button>
              <label className="vs-view">Vista<select aria-label="Vista de oficina" value={view} onChange={event => setView(event.target.value as keyof typeof sceneViews)}><option value="all">Oficina completa</option><option value="director">Dirección</option><option value="meeting">Reuniones</option><option value="coffee">Café</option></select></label>
              <label className="vs-motion"><input type="checkbox" checked={reduced} onChange={event => setReduced(event.target.checked)} />Movimiento reducido</label>
            </div>
            <div className="vs-timeline" aria-label="Elegir actividad del director">
              {scenes.map((scene, index) => <button type="button" key={scene.time} className={scene.time === currentScene.time ? 'is-active' : ''} aria-pressed={scene.time === currentScene.time} onClick={() => seek('previewTime' in scene ? scene.previewTime : scene.time)}><span>{String(index + 1).padStart(2, '0')}</span>{scene.label}</button>)}
            </div>
            <p className="vs-scene-description">{currentScene.detail}</p>
          </section>

          <aside className="vs-character-card" aria-labelledby="vs-character-title">
            <div className="vs-card-heading"><span className="vs-eyebrow">CONOCE AL EQUIPO</span><h2 id="vs-character-title">{activeRole.name}</h2><p>{activeRole.title}</p></div>
            <div className="vs-portrait" style={{ '--role-color': activeRole.color } as React.CSSProperties}>
              <div className="vs-portrait-orbit" />
              {selection && assetUrls[selection.file] ? <img src={assetUrls[selection.file]} alt={`${activeRole.name}, pose ${selection.clip}, vista ${selection.facing}`} /> : <span className="vs-missing">Recurso pendiente</span>}
              <span className="vs-portrait-chip">{selection?.facing ?? 'front'} / {selection?.clip ?? 'idle'}</span>
            </div>
            <div className="vs-roles" aria-label="Elegir personaje">{roles.map(entry => <button type="button" key={entry.id} onClick={() => chooseRole(entry.id)} className={role === entry.id ? 'is-active' : ''} aria-pressed={role === entry.id}><span style={{ background: entry.color }} />{entry.name}{role === entry.id && <Check size={12} />}</button>)}</div>
            <div className="vs-pose-controls">
              <label>Pose<select aria-label="Pose del personaje" value={clip} onChange={event => { setClip(event.target.value); setFacing('front'); }}>{[...new Set(available.map(asset => asset.clip || 'idle'))].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
              <label>Vista<select aria-label="Vista del personaje" value={facing} onChange={event => setFacing(event.target.value)}>{[...new Set(available.filter(asset => asset.clip === clip).map(asset => asset.facing || 'front'))].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
            </div>
            <p className="vs-character-note">Recursos del catálogo. Las poses se componen con movimiento de escena; el recorrido es una simulación visual.</p>
          </aside>
        </div>

        <section className="vs-gallery" aria-labelledby="vs-gallery-title">
          <div className="vs-gallery-heading"><div><p className="vs-eyebrow"><GalleryVerticalEnd size={14} />CATÁLOGO DE RECURSOS</p><h2 id="vs-gallery-title">Cada detalle tiene su lugar.</h2></div><label className="vs-gallery-filter">Mostrar<select aria-label="Categoría del catálogo" value={galleryKind} onChange={event => setGalleryKind(event.target.value)}><option value="character">Personajes</option><option value="furniture">Muebles</option><option value="electronics">Electrónica</option><option value="effect">Efectos</option></select></label></div>
          <div className="vs-gallery-grid">{gallery.map(asset => <article className="vs-asset-card" key={asset.id}><div>{assetUrls[asset.file] ? <img loading="lazy" src={assetUrls[asset.file]} alt={asset.id.replaceAll('.', ' ')} /> : <span>Archivo no disponible</span>}</div><strong>{asset.id.replace(/^character\.|^furniture\.|^electronics\.|^effect\./, '').replaceAll('.', ' / ')}</strong><span>{asset.logicalSize.width} × {asset.logicalSize.height} · {asset.status ?? 'catalogado'}</span></article>)}</div>
          {gallery.length === 0 && <p className="vs-empty">Esta categoría todavía no tiene recursos en el catálogo.</p>}
          {failed.length > 0 && <p role="status" className="vs-error">{failed.length} recursos no se pudieron cargar: {failed.map(file => file.split('/').at(-1)).join(', ')}</p>}
        </section>
        <footer className="vs-footer"><span>Agent Viewer · Office Crew</span><span>Contribución visual: ChatGPT (OpenAI Codex)</span><span>Escena y noticias simuladas. No modifica agentes reales ni métricas de uso.</span></footer>
      </div>
    </main>
  );
}
