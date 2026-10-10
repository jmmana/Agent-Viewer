import { useEffect, useMemo, useState } from 'react';
import { loadCrewPropImage, type CrewPropImageId } from './crewPropImages';

/** La imagen pertenece a la sala montada, sin caché global ni cambios de dominio. */
function useCrewPropImage(id: CrewPropImageId | null) {
  const [loaded, setLoaded] = useState<{ id: CrewPropImageId; image: HTMLImageElement } | null>(null);
  const [failedId, setFailedId] = useState<CrewPropImageId | null>(null);
  useEffect(() => {
    setLoaded(null);
    setFailedId(null);
    if (!id) return;
    return loadCrewPropImage(id, image => setLoaded({ id, image }), () => setFailedId(id));
  }, [id]);
  return { image: loaded?.id === id ? loaded.image : undefined, failed: id !== null && failedId === id };
}

/**
 * Carga solo las imágenes de mueble que la sala actual necesita (conjunto acotado,
 * ver `CREW_ROOM_PROP_IMAGES`); se cancela y libera al cambiar de sala o desmontar,
 * igual que `useCrewSprites` para los actores.
 */
export function useCrewPropImages(ids: readonly CrewPropImageId[]) {
  const deskExecutive = useCrewPropImage(ids.includes('desk-executive') ? 'desk-executive' : null);
  const plantFloor = useCrewPropImage(ids.includes('plant-floor') ? 'plant-floor' : null);
  const images = useMemo(() => ({
    'desk-executive': deskExecutive.image,
    'plant-floor': plantFloor.image,
  }) as Partial<Record<CrewPropImageId, HTMLImageElement>>, [deskExecutive.image, plantFloor.image]);
  return { images, failed: deskExecutive.failed || plantFloor.failed };
}
