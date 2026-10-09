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
