/// <reference types="vite/client" />
import manifest from '../../assets/asset-manifest.json';

export interface StudioAsset {
  id: string;
  kind: string;
  file: string;
  role?: string;
  clip?: string;
  facing?: string;
  logicalSize: { width: number; height: number };
  anchor: { x: number; y: number };
  screenRect?: { x: number; y: number; width: number; height: number };
  status?: string;
}
export interface RoomLayout {
  id: string;
  size: { width: number; height: number };
  placements: { id?: string; assetId: string; x: number; y: number; supportAssetId?: string; supportPlacementId?: string }[];
}

const files = import.meta.glob<string>([
  '../../assets/characters/*/*.{svg,png,webp}',
  '../../assets/furniture/*.svg',
  '../../assets/electronics/*.svg',
  '../../assets/effects/*.svg',
], { eager: true, query: '?url', import: 'default' });
export const assetUrls = Object.fromEntries(Object.entries(files).map(([path, url]) => [path.replace('../../', ''), url]));
// The main catalog remains the authority. Layouts only describe how catalog entries are placed.
export const studioAssets = manifest.assets as StudioAsset[];
const layoutFiles = import.meta.glob<RoomLayout>('../../assets/rooms/**/layout.json', { eager: true, import: 'default' });
export const roomLayouts = Object.fromEntries(Object.values(layoutFiles).map(layout => [layout.id, layout]));
export const roles = [
  { id: 'ceo', name: 'Director', title: 'Coordina al equipo', color: '#f2ba54' },
  { id: 'planner', name: 'Planner', title: 'Organiza las tareas', color: '#a789e6' },
  { id: 'developer', name: 'Developer', title: 'Construye soluciones', color: '#65b7e4' },
  { id: 'analyst', name: 'Analyst', title: 'Explora los datos', color: '#70c7b2' },
  { id: 'reviewer', name: 'Reviewer', title: 'Verifica la calidad', color: '#ed969f' },
  { id: 'finance', name: 'Finance', title: 'Revisa los recursos', color: '#7bb9a4' },
] as const;

export function findCharacter(role: string, clip = 'idle', facing = 'front') {
  return studioAssets.find(asset => asset.kind === 'character' && asset.role === role && asset.clip === clip && asset.facing === facing)
    ?? studioAssets.find(asset => asset.kind === 'character' && asset.role === role && asset.clip === 'idle' && asset.facing === facing)
    ?? studioAssets.find(asset => asset.kind === 'character' && asset.role === role && asset.clip === 'idle' && asset.facing === 'front');
}

export const scenes = [
  { time: 0, label: 'En su escritorio', detail: 'El director revisa una tarea en su laptop.' },
  { time: 7, label: 'Llamada', detail: 'Una llamada ilustrativa, con señal y efecto de teléfono.' },
  { time: 14, label: 'Camino a la reunión', detail: 'El director recorre el pasillo hacia la sala del equipo.' },
  { time: 22, label: 'Reunión de equipo', detail: 'Planner, Analyst y Reviewer participan en una reunión simulada.' },
  { time: 30, previewTime: 36, label: 'Pausa de café', detail: 'El director visita la zona de descanso.' },
  { time: 38, label: 'Regreso', detail: 'El director vuelve a su escritorio para comenzar otro ciclo.' },
] as const;
export const CYCLE_SECONDS = 44;
export function sceneAt(seconds: number) {
  return [...scenes].reverse().find(scene => seconds >= scene.time) ?? scenes[0];
}
