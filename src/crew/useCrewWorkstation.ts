import { useEffect, useState } from 'react';
import { loadCrewImage } from './crewSprites';
import { CREW_WORKSTATION } from './crewWorkstationLayer';

export function useCrewWorkstation(active: boolean, roomId: string) {
  const [loaded, setLoaded] = useState<{ roomId: string; image: HTMLImageElement } | null>(null);
  useEffect(() => {
    setLoaded(null);
    if (!active) return;
    return loadCrewImage(async () => (await import('./sprites/ceo-workstation')).default,
      CREW_WORKSTATION, image => setLoaded({ roomId, image }), () => setLoaded(null));
  }, [active, roomId]);
  return active && loaded?.roomId === roomId ? loaded.image : undefined;
}
