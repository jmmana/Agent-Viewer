import { useEffect, useRef, useState } from 'react';
import { CrewAudioEngine, type CrewAudioState } from './crewAudioEngine';
import { CREW_ROOM_MUSIC, type CrewAudioCueId } from './crewAudioAssets';

export interface UseCrewAudioResult {
  /** Estado del motor: ver `CrewAudioState`. `unsupported` = sin Web Audio API (navegador o entorno de prueba). */
  state: CrewAudioState;
  /** La sala activa tiene una pista configurada (hoy, solo la sala de descanso). */
  roomHasTrack: boolean;
  /** Inicia el audio de la sala. Llamar solo desde un manejador de clic/tecla del usuario. */
  play: () => void;
  pause: () => void;
  /** Efecto corto de un disparo, independiente de la música de fondo. Por defecto, `ui-notification`. */
  playCue: (id?: CrewAudioCueId) => void;
}

/**
 * Conecta el motor de audio de Crew (#150) al ciclo de vida de React: una instancia
 * por montaje de `CrewStage`, sincronizada con la sala activa y las preferencias de
 * mute/volumen (#157, ya persistidas en `crewPreferences.ts`). Pausa al perder el
 * foco de la ventana o la pestaña y reanuda solo si ya sonaba antes de perderlo
 * (nunca un autoplay nuevo). `dispose()` corre siempre al desmontar.
 */
export function useCrewAudio(options: { roomId: string; muted: boolean; volume: number }): UseCrewAudioResult {
  const { roomId, muted, volume } = options;
  const engineRef = useRef<CrewAudioEngine | null>(null);
  const [state, setState] = useState<CrewAudioState>('idle');

  /**
   * Crea el motor si falta o si el anterior ya fue `dispose()`-ado. Esto último pasa
   * en React StrictMode (desarrollo): limpia y vuelve a correr el efecto de montaje
   * una vez, sin una renderización real entre medio, así que el chequeo de "¿existe
   * ya una instancia?" de la renderización no alcanza a recrearlo a tiempo; por eso
   * el propio efecto también llama a esta función en vez de asumir `engineRef.current`.
   */
  function ensureEngine(): CrewAudioEngine {
    if (!engineRef.current || engineRef.current.disposed) {
      engineRef.current = new CrewAudioEngine({ muted, volume, roomId, onStateChange: setState });
    }
    return engineRef.current;
  }
  ensureEngine(); // instancia síncrona disponible ya en la primera renderización (botones Play/Pause)

  useEffect(() => {
    const engine = ensureEngine();
    const onBlur = () => engine.suspendForFocusLoss();
    const onFocus = () => engine.resumeFromFocus();
    const onVisibility = () => {
      if (document.hidden) engine.suspendForFocusLoss();
      else engine.resumeFromFocus();
    };
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      engine.dispose();
    };
    // Una sola vez por instancia de motor: no se debe recrear por cambios de sala/preferencia.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    engineRef.current?.setRoom(roomId);
  }, [roomId]);

  useEffect(() => {
    engineRef.current?.setPreferences(muted, volume);
  }, [muted, volume]);

  return {
    state,
    roomHasTrack: CREW_ROOM_MUSIC[roomId] != null,
    play: () => { void engineRef.current?.play(); },
    pause: () => engineRef.current?.pause(),
    playCue: (id?: CrewAudioCueId) => engineRef.current?.playCue(id),
  };
}
