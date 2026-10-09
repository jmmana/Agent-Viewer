import { useEffect, useState } from 'react';
import type { CrewView } from './crewModel';
import { loadCrewSprite } from './crewSprites';

type SpriteMap = Partial<Record<CrewView, HTMLImageElement>>;

/** Carga las vistas distintas requeridas por la sala; cada imagen pertenece a la escena montada. */
export function useCrewSprites(views: readonly CrewView[]) {
  const key = [...new Set(views)].sort().join(',');
  const [loaded, setLoaded] = useState<{key: string; images: SpriteMap}>({key: '', images: {}});
  const [failed, setFailed] = useState<{key: string; views: CrewView[]}>({key: '', views: []});
  useEffect(() => {
    setLoaded({key, images: {}});
    setFailed({key, views: []});
    const stops = (key ? key.split(',') as CrewView[] : []).map(view => loadCrewSprite(view,
      image => setLoaded(prev => prev.key === key ? {key, images: {...prev.images, [view]: image}} : prev),
      () => setFailed(prev => prev.key === key ? {key, views: [...prev.views, view]} : prev)));
    return () => stops.forEach(stop => stop());
  }, [key]);
  return {
    images: loaded.key === key ? loaded.images : {},
    failed: failed.key === key && failed.views.length > 0,
  };
}
