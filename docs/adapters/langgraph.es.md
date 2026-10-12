# Adaptador de LangGraph

[English version](langgraph.md)

`AgentViewerCallbackHandler` reporta una ejecución de LangGraph a Agent Viewer a través del sistema de callbacks
propio de LangChain. Existe para los dos lenguajes, con los mismos eventos y las mismas reglas de privacidad:

| Lenguaje | Instalación | Import |
|---|---|---|
| TypeScript | `npm install @warlockcode/agent-viewer-langgraph @warlockcode/agent-viewer-sdk @langchain/core` | `import { AgentViewerCallbackHandler } from '@warlockcode/agent-viewer-langgraph'` |
| Python | `pip install "agent-viewer[langgraph]"` | `from agent_viewer_langgraph import AgentViewerCallbackHandler` |

`@langchain/core` y `@warlockcode/agent-viewer-sdk` son peer dependencies del paquete de npm, así que usa las
copias que tu app ya tiene.

## TypeScript

```ts
import { AgentViewerCallbackHandler } from '@warlockcode/agent-viewer-langgraph';

const handler = new AgentViewerCallbackHandler({ url: 'http://localhost:8787', runtimeId: 'my-graph' });
await graph.invoke(inputs, { callbacks: [handler], configurable: { thread_id: 'thread-1' } });
await handler.flush(); // antes de que termine un script corto
```

Opciones (todas opcionales): `viewer` (un cliente `AgentViewer` existente), `url`, `apiKey`, `runtimeId` (por
defecto `'langgraph'`), `agentForNode(node, metadata)` (por defecto el nombre del nodo es el id del agente),
`sessionFor(metadata)` (por defecto `thread_id`), `taskFor(metadata)`, `toolInputSummary` / `toolOutputSummary`
(opt-in, apagados por defecto), `reportedCost(result)`, `maxQueue` (1000), `batchSize` (50), `onError`, `debug`.
`handler.stats()` devuelve los contadores `sent`, `failed`, `dropped` y `callsWithoutUsage`.

Hay un proyecto ejecutable con un chat model falso (sin proveedor ni API key) en
[`examples/langgraph/`](../../examples/langgraph/README.md).

## Python

```python
from agent_viewer_langgraph import AgentViewerCallbackHandler

handler = AgentViewerCallbackHandler(url="http://localhost:8787", runtime_id="my-graph")
graph.invoke(inputs, config={"callbacks": [handler], "configurable": {"thread_id": "thread-1"}})
handler.flush()
```

Los eventos salen desde un hilo daemon a través de una cola acotada y se vacían al cerrar el intérprete. Están
disponibles `handler.stats()`, `handler.flush(timeout)` y `handler.close(timeout)`.

## Qué se reporta

| Callback de LangGraph | Evento de Agent Viewer |
|---|---|
| Primera ejecución de un nodo | `agent.registered` (el agente del nodo) |
| El nodo empieza | `agent.status.changed` → Pensando |
| El nodo termina | `agent.status.changed` → Listo |
| El nodo falla | `agent.status.changed` → Bloqueado (Esperando si es una interrupción: `GraphInterrupt`, `NodeInterrupt`, ...) |
| Herramienta empieza, termina, falla | `tool.started`, `tool.completed`, `tool.failed` |
| Termina una llamada al modelo | `llm.usage`, solo si el proveedor reportó tokens de entrada y de salida |
| Falla una llamada al modelo | `llm.failed`, con un `errorKind` derivado del nombre de la clase del error |

- Los ids de evento son deterministas, `lg:<runtimeId>:<runId>:<eventKind>`, así que un callback repetido es un
  duplicado idempotente en el servidor.
- Proveedor y modelo salen de `ls_provider` y `ls_model_name`. Los tokens salen del `usage_metadata` del mensaje
  y, si no está, del `llmOutput` del proveedor. Un conteo que el proveedor no reportó nunca se pone en 0, y nunca
  se estima un costo: solo `reportedCost` envía uno.
- `thread_id` se convierte en la sesión. Si falta, no se inventa nada.

## Privacidad

Solo salen del proceso nombres, conteos y tiempos. Nunca se envían prompts, respuestas, entradas ni salidas de
herramientas, ni mensajes de error (los resúmenes de herramientas son opt-in). La metadata de los callbacks pasa
por `METADATA_WHITELIST`: `langgraph_node`, `thread_id`, `ls_provider`, `ls_model_name`, `ls_model_type`.

## Fiabilidad

Ningún callback espera a la red: cada uno encola sus eventos y retorna, así que un servidor lento o caído nunca
bloquea el grafo. Con la cola llena el evento se descarta y se cuenta. Nada que lance el handler llega al grafo.

## Migrar desde `examples/langgraph-adapter.ts`

El ejemplo viejo escrito a mano (`LangGraphViewerAdapter` con `onNodeStart`, `onToolStart`, `onModelUsage`, ...) se
eliminó. Borra tu copia y las llamadas manuales, y pasa el handler:

```diff
- import { LangGraphViewerAdapter } from './langgraph-adapter';
+ import { AgentViewerCallbackHandler } from '@warlockcode/agent-viewer-langgraph';
+ await graph.invoke(inputs, { callbacks: [new AgentViewerCallbackHandler({ runtimeId: 'my-graph' })] });
```
