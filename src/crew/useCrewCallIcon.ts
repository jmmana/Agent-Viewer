import { useEffect, useState } from 'react';
import { loadCrewCallIcon } from './crewCallIcon';

/**
 * Un solo icono de llamada para toda la escena Crew (issue #145): no depende de la sala
 * ni del agente. Si la carga falla, `drawCrewCallOverlay` dibuja un glifo de respaldo con
 * la misma paleta, igual que el resto de imágenes del banco (`useCrewPropImages`).
 */
export function useCrewCallIcon() {
  const [image, setImage] = useState<HTMLImageElement>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setImage(undefined);
    setFailed(false);
    return loadCrewCallIcon(img => setImage(img), () => setFailed(true));
  }, []);
  return { image, failed };
}
