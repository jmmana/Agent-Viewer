<p align="center">
  <img src="docs/assets/agent-viewer-banner.svg" width="100%" alt="Agent Viewer — Observabilidad visual para tus agentes de IA en una oficina virtual viva." />
</p>

<p align="center">
  <strong>Mira trabajar a tus agentes de IA.</strong><br />
  Una oficina virtual interactiva para observabilidad multiagente, colaboración, telemetría de tokens y costes.
</p>

<p align="center">
  <a href="https://github.com/jmmana/Agent-Viewer/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/jmmana/Agent-Viewer/ci.yml?branch=main&style=flat-square&label=CI" alt="Estado CI" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D24.0.0-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node 24" />
  <img src="https://img.shields.io/badge/version-1.0.0-blue?style=flat-square" alt="Versión 1.0.0" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="Licencia MIT" /></a>
  <a href="https://github.com/jmmana/Agent-Viewer/stargazers"><img src="https://img.shields.io/github/stars/jmmana/Agent-Viewer?style=flat-square&color=a855f7" alt="GitHub stars" /></a>
</p>

<p align="center">
  <a href="#inicio-rápido">Inicio rápido</a> ·
  <a href="#la-idea">La idea</a> ·
  <a href="#arquitectura">Arquitectura</a> ·
  <a href="#contrato-canónico-de-eventos">Contrato de eventos</a> ·
  <a href="#compatibilidad-con-frameworks">Frameworks</a> ·
  <a href="#sdks-en-python-y-typescript">SDKs</a> ·
  <a href="#integra-la-oficina-en-tu-app-react">Librería React</a> ·
  <a href="README.md">English</a>
</p>

---

## Inicio rápido

Ejecuta simultáneamente la interfaz de la oficina (puerto 3000) y el servidor de ingesta de eventos en tiempo real (puerto 8787):

```bash
git clone https://github.com/jmmana/Agent-Viewer.git
cd Agent-Viewer
npm ci
npm run dev:full
```

Abre **http://localhost:3000** en tu navegador. La oficina se conectará automáticamente al servidor SSE en **http://localhost:8787**.

### Envía un evento de prueba con cURL

En otra terminal, emite un evento directamente a la oficina:

```bash
curl -X POST http://localhost:8787/api/v1/events \
  -H "Content-Type: application/json" \
  -d '{
    "schemaVersion": "1.0",
    "id": "evt_test_es_1",
    "type": "agent.message.sent",
    "timestamp": 1728345600000,
    "source": "cli",
    "agentId": "boss",
    "summary": "Carlos: ¡Despliegue completado con éxito!",
    "payload": {
      "text": "¡Despliegue completado con éxito!"
    }
  }'
```

¡El personaje en la oficina mostrará de inmediato el mensaje en su tarjeta de diálogo en tiempo real!

---

## Integra la oficina en tu app React

Agent Viewer también es una librería React: `@warlockcode/agent-viewer` 0.2.0 (solo módulos ES, con React y React DOM 19 como dependencias peer). La oficina se dibuja solo con los eventos que le pasas, nunca calcula consumo y no inyecta estilos. La publicación en npm llegará pronto; mientras tanto, instálala desde la release de GitHub:

```bash
npm install https://github.com/jmmana/Agent-Viewer/releases/download/v0.2.0/warlockcode-agent-viewer-0.2.0.tgz
```

```tsx
import { AgentOffice, type AgentProfile, type OfficeEventInput } from '@warlockcode/agent-viewer';
import '@warlockcode/agent-viewer/style.css';

const agents: AgentProfile[] = [
  { id: 'planner', name: 'Nova', roleTitle: 'Planificadora', workspace: 'leads_area' },
  { id: 'builder', name: 'Atlas', roleTitle: 'Desarrollador', workspace: 'development' },
];
const events: OfficeEventInput[] = [
  { id: 'e1', type: 'agent.status.changed', timestamp: 1767225600000, source: 'agent:builder', agentId: 'builder', payload: { status: 'CODING' } },
  { id: 'e2', type: 'agent.message.sent', timestamp: 1767225601000, source: 'agent:planner', agentId: 'planner', payload: { text: 'Primero el parser.', kind: 'proposal', targetAgentId: 'builder' } },
];

export function OficinaDelEquipo() {
  return <div style={{ height: 520 }}><AgentOffice agents={agents} events={events} locale="es" /></div>;
}
```

Agrega eventos nuevos al arreglo para ver la actividad en vivo, o usa `useEventReplay` y `ReplayControls` para repetir una ejecución grabada. Las props, el efecto de cada evento, las traducciones, los temas, las reglas de consumo y la exportación de video están en la [guía de la librería](docs/library.es.md).

---

## La idea

**Agent Viewer transforma la actividad de sistemas multiagente en un espacio de trabajo visual intuitivo.** En lugar de analizar largos logs o JSON crudos en terminales, observas la colaboración entre agentes:
- El Director coordina a los líderes en la suite ejecutiva.
- Los arquitectos planifican y delegan a ingenieros en estaciones de trabajo.
- Los agentes colaboran en las Salas de Reuniones A y B.
- El centro de operaciones NOC de Model Ops rastrea tokens, latencia y costes en vivo.
- Los agentes inactivos toman café en la cafetería sin alterar jamás su estado operativo autoritativo.

---

## Arquitectura

```
┌─────────────────────────────────────────────────────────────┐
│                      Runtimes Externos                      │
│  (LangGraph / CrewAI / AutoGen / Python SDK / TypeScript)   │
└──────────────┬──────────────────────────────┬───────────────┘
               │ HTTP POST /api/v1/events     │ Webhook Genérico
               ▼                              ▼
┌─────────────────────────────────────────────────────────────┐
│          Servidor de Ingesta (Express + Almacén)            │
│  - Validación con Zod del Contrato Canónico V1              │
│  - Almacén de eventos en memoria y SQLite persistente       │
│  - Transmisión en tiempo real vía Server-Sent Events (SSE)  │
└──────────────────────────────┬──────────────────────────────┘
                               │ SSE Stream /api/v1/events/stream
                               ▼
┌─────────────────────────────────────────────────────────────┐
│             Cliente Web / SPA (Agent Viewer)                │
│  - Renderizador Canvas 2.5D Isomórfico                      │
│  - Motor de animación y vida ambiental desacoplado         │
│  - Panel de telemetría de tokens y costes en Model Ops      │
│  - Persistencia de sesión y panel de inspección             │
└─────────────────────────────────────────────────────────────┘
```

---

## Contrato Canónico de Eventos

Todos los eventos siguen el sobre canónico de versión `1.0`:

| Campo | Tipo | Descripción |
|---|---|---|
| `schemaVersion` | `"1.0"` | Versión canónica del esquema |
| `id` | `string` | ID único del evento (clave de idempotencia) |
| `type` | `string` | Tipo canónico de evento (ej. `agent.status.changed`) |
| `timestamp` | `number` | Unix epoch en milisegundos |
| `source` | `string` | Identificador del emisor (ej. `runtime:crewai`) |
| `agentId` | `string?` | Identificador opcional del agente |
| `summary` | `string` | Resumen legible para auditoría (1–500 caracteres) |
| `payload` | `object` | Detalle específico según el tipo de evento |

---

## Compatibilidad con Frameworks

| Framework | Estado | Detalle |
|---|---|---|
| **Python SDK** | ✅ Listo para Producción | Paquete `agent-viewer` (`sdk/python/`) |
| **TypeScript SDK** | ✅ Listo para Producción | Cliente nativo TypeScript (`sdk/typescript/`) |
| **Webhooks Genéricos**| ✅ Listo para Producción | `POST /api/v1/webhooks/generic` con HMAC SHA-256 |
| **LangGraph** | 🟢 Adaptador Funcional | Ejemplo probado en `examples/langgraph-adapter.ts` |
| **CrewAI** | 🟢 Adaptador Funcional | Ejemplo probado en `examples/crewai-adapter.py` |
| **AutoGen** | 🟢 Adaptador Funcional | Ejemplo probado en `examples/autogen-adapter.py` |
| **OpenAI Swarm** | 🟡 Esqueleto / Prototipo | Mapeo base en `examples/swarm-adapter.py` |
| **Google GenAI ADK** | 🟡 Esqueleto / Prototipo | Mapeo base en `examples/google-adk-adapter.ts` |

---

## SDKs en Python y TypeScript

### SDK de Python
```python
import os
from agent_viewer import AgentViewer

viewer = AgentViewer(url="http://localhost:8787", token=os.getenv("AGENT_VIEWER_API_TOKEN"))
agent = viewer.agent("analyst_1", name="Analista de Mercado", role_title="Investigación Financiera")

agent.thinking("Analizando extractos y estados bancarios")
agent.tool_started("extractor_financiero", input_summary="Documento 10-K")
agent.tool_completed("extractor_financiero", output_summary="42 páginas procesadas")
agent.usage("OpenAI", "gpt-4o", input_tokens=4200, output_tokens=320, cost=0.024)
agent.message("¡Análisis preliminar concluido!")
agent.done("Resumen listo para el equipo")
```

---

## Controles

| Acción | Control |
|---|---|
| Reproducir / Pausar Demo | Botón Play o **Barra espaciadora** |
| Avanzar un paso | Botón Step en pausa |
| Reiniciar sesión | Botón Reset en barra superior |
| Desplazar la oficina | Arrastrar el canvas con ratón |
| Zoom | Rueda del ratón o botones `+` / `-` en el HUD |
| Maximizar tablero | Icono de expandir en menú inferior |
| Mostrar u ocultar Timeline | Botón en HUD o "Show activity timeline" |
| Cambiar vistas | **O** (Oficina) / **T** (Tareas) / **M** (Reuniones) |

---

## Verificación y Pruebas

```bash
# Comprobación de tipos
npm run lint

# Pruebas unitarias e integración de TypeScript
npm test

# Pruebas del SDK de Python contra el servidor real
python3 tests/test_python_sdk.py

# Construcción de producción
npm run build
```

---

## Seguridad

Para reportar vulnerabilidades de forma privada, utiliza [GitHub Security Advisories](https://github.com/jmmana/Agent-Viewer/security/advisories/new) o escribe a `jmmana@gmail.com`. Consulta [SECURITY.md](SECURITY.md) para más detalles sobre endurecimiento en producción.

---

## Autor y Licencia

Creado por **[Juan Manuel Castillo Pinto](https://github.com/jmmana)** · **WarlockCode**  
Publicado bajo la [Licencia MIT](LICENSE).
