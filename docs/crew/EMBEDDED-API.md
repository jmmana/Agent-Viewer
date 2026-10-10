# Integración de Crew con AgentOffice

Relacionado: #166, #171 y Epic #114. Disponible en la rama de implementación; no representa una release publicada ni arte final aprobado.

`AgentOffice` conserva Caricatura por defecto. La propiedad `mode` sigue controlando la semántica de eventos (`professional` o `showcase`); `visualMode` elige exclusivamente el renderer (`cartoon` o `crew`). Cambiar el renderer no crea otro store ni altera los eventos recibidos.

```tsx
import { useState } from 'react';
import {
  AgentOffice,
  type CrewCameraByRoom,
  type OfficeEventInput,
} from '@warlockcode/agent-viewer';
import '@warlockcode/agent-viewer/style.css';

export function TeamOffice({ events }: { events: readonly OfficeEventInput[] }) {
  const [room, setRoom] = useState('development');
  const [cameras, setCameras] = useState<CrewCameraByRoom>({});

  return (
    <AgentOffice
      events={events}
      mode="professional"
      visualMode="crew"
      crewRoomId={room}
      onCrewRoomChange={setRoom}
      crewCameras={cameras}
      onCrewCamerasChange={setCameras}
      locale="es"
      style={{ height: 560 }}
    />
  );
}
```

| Propiedad | Contrato |
| --- | --- |
| `visualMode` | `cartoon` por defecto. El host puede alternarlo sin desmontar AgentOffice para conservar su estado local. |
| `crewRoomId` | Sala controlada. ID desconocido muestra Dirección sin inventar otra escena. |
| `onCrewRoomChange` | Solicitud de cambio de sala. En modo controlado, el host actualiza la prop para aceptarla. |
| `crewCameras` | Mapa por ID: `{ view, zoom, pan: { x, y } }`. Se valida sin mutar el objeto del host. |
| `onCrewCamerasChange` | Solicitud de nuevo mapa de cámaras; se puede guardar en la persistencia del host. No contiene datos de agentes. |

Las propiedades controladas deben acompañarse de sus callbacks si se desea permitir interacción. Sin las propiedades de sala/cámaras, cada instancia conserva su propio estado en memoria, incluyendo cambios entre Caricatura y Crew. Desmontar AgentOffice descarta ese estado; el host controla la persistencia entre sesiones.

La biblioteca no lee ni escribe preferencias Crew en localStorage ni altera la URL del host. Tampoco muestra los enlaces directos propios de la aplicación de demostración. Dos instancias usan identificadores de controles distintos, cámaras distintas y los stores independientes que AgentOffice ya proveía.

Restablecer Crew solicita Dirección y un mapa de cámaras vacío. Mantiene el renderer elegido, los eventos, la selección y los valores de consumo. Una sala sin agentes sigue vacía. `showUsage` conserva su contrato de privacidad; cambiar a Crew no habilita cifras ocultas.

Las cuatro vistas son presets discretos 2.5D. El catálogo y el mobiliario siguen siendo prototipos; faltan actores con arte final; los marcadores provisionales de presencia permiten foco desde el panel Crew. El texto alternativo de agentes continúa disponible, pero seleccionar un agente no garantiza aún foco visual en Crew. Los controles Crew incorporan ES/EN; las personalizaciones `messages`/`t` del host siguen aplicando a los textos existentes de AgentOffice, no aún al catálogo de controles Crew.

Para comparar dos instancias durante desarrollo, abrir `/tests/e2e/fixtures/crew-embedded.html` con Vite. Es una fixture de QA sin eventos; no forma parte del build de la aplicación. La prueba Playwright verifica sala/cámara controladas, independencia, alternancia de modos y vista móvil. Pruebas Vitest cubren callbacks en StrictMode, props rechazadas por el host, datos corruptos y ausencia de acceso a almacenamiento global.

## Puente de eventos y modo de visualización, #155

`AgentOffice` expone ahora un puente de solo lectura entre el snapshot y el estado visual de Crew, además de dos propiedades presentacionales:

| Propiedad | Contrato |
| --- | --- |
| `crewViewerMode` | `'LIVE' \| 'DEMO' \| 'REPLAY'`, el mismo vocabulario que `ViewerMode` de `integrations/replayEngine.ts`. AgentOffice nunca lo infiere de los eventos recibidos: sin esta prop, Crew no muestra ninguna insignia. El host decide y pasa el valor explícitamente. |
| `crewVisibility` | `'full'` (por defecto) o `'minimized'`. En `minimized`, Crew oculta el título de la tarea y el tema de la reunión de cada agente (pensado para pantallas públicas o televisores de oficina) conservando solo la categoría (hay tarea/reunión y su estado, pero no su texto). |

Internamente, `CrewStage` ahora también recibe `tasks` y `meetings` del snapshot (agregados a `OfficeSnapshot`) para proyectar, de forma determinista y sin alterar el dominio, una línea de actividad por agente junto a su nombre: tarea asignada y su estado, participación en una reunión activa, aprobación pendiente (`WAITING_APPROVAL`) y uso de herramienta en curso. Ningún dato se calcula: todo viene directo de `agent.status`, `agent.currentTaskId`, `agent.currentTool` y las listas de tareas/reuniones ya existentes. El puente vive en `src/crew/crewEventBridge.ts` y se exporta desde el paquete (`crewAgentActivity`, `crewActivityLine`, `crewViewerModeLabel`, tipos `CrewViewerMode`/`CrewVisibility`/`CrewAgentActivity`).

Lo que este incremento NO resuelve: Crew sigue sin motor de audio (#150), sin animación real de reuniones o traslados, y `crewVisibility: 'minimized'` no redacta `statusText` ni `speechBubble` (solo tarea/reunión); una pantalla pública que necesite ocultar también esos textos debe hacerlo hoy del lado del host. Los buffers, el dedupe por ID, el orden de eventos fuera de secuencia y la reconexión SSE ya los resuelve el `OfficeStore`/`applyExternalEvent` compartido con Caricatura (issue #54/#72): Crew no reimplementa esa infraestructura porque lee el mismo snapshot.

## Preferencias de movimiento, #171

`crewPreferences?: { version: 1; reducedMotion: boolean }` y
`onCrewPreferencesChange?: (preferences: CrewPreferences) => void` siguen el
mismo contrato controlado que las cámaras. El host decide aceptar el cambio;
la biblioteca nunca muta el objeto recibido. Sin prop, cada instancia conserva
su preferencia durante cambios Caricatura/Crew, sin almacenamiento global.
Restablecer Crew solicita `{ version: 1, reducedMotion: false }` junto con sala
Dirección y cámaras vacías. El sistema `prefers-reduced-motion: reduce` siempre
mantiene los clips desactivados, incluso si la preferencia propia es false.

Anterior/siguiente recorre el orden del catálogo y se desactiva en los extremos.
Solicita `onCrewRoomChange`, sin modificar eventos, reunión o replay. La
biblioteca no produce audio: el sonido de la aplicación sigue usando los
controles existentes y su propia preferencia global versionada.
