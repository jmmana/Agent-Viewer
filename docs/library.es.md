# Guía de la librería Agent Viewer

`@warlockcode/agent-viewer` lleva la oficina de Agent Viewer a tu propia app React. La oficina es una escena Canvas2D que se dibuja solo con los eventos que le pasas: los agentes que registra tu runtime, sus estados, las herramientas que usan, los mensajes que envían y las reuniones que hacen.

Esta guía cubre la versión **0.2.0**. Read in English: [library.md](library.md).

## Contenido

- [Instalación](#instalación)
- [Importa los estilos](#importa-los-estilos)
- [Ejemplo mínimo](#ejemplo-mínimo)
- [Eventos en vivo](#eventos-en-vivo)
- [Props de `<AgentOffice>`](#props-de-agentoffice)
- [Modos](#modos)
- [Cómo cambian la oficina los eventos](#cómo-cambian-la-oficina-los-eventos)
- [Tipos de mensaje y burbujas](#tipos-de-mensaje-y-burbujas)
- [Espacios de trabajo](#espacios-de-trabajo)
- [Traducciones](#traducciones)
- [Temas y estilos](#temas-y-estilos)
- [Accesibilidad](#accesibilidad)
- [Cifras de consumo](#cifras-de-consumo)
- [Repetición](#repetición)
- [Cargar un archivo de log](#cargar-un-archivo-de-log)
- [Exportar video](#exportar-video)
- [El modelo de la oficina sin árbol React](#el-modelo-de-la-oficina-sin-árbol-react)
- [Utilidades del contrato de eventos](#utilidades-del-contrato-de-eventos)
- [Referencia de la API](#referencia-de-la-api)
- [Garantías de aislamiento](#garantías-de-aislamiento)
- [Versiones](#versiones)

## Instalación

Requisitos:

- React y React DOM 19 (`^19.0.0`). Son dependencias peer, así que las aporta tu app.
- Un bundler o framework que entienda módulos ES e importaciones de CSS (Vite, Next.js, webpack y similares). El paquete es solo ESM: no hay build CommonJS.

Las dependencias de ejecución son `lucide-react` (iconos), `zod` (validación estricta de eventos) y `express` (el servidor del comando `agent-viewer`; los módulos de la librería nunca lo importan, así que no llega a tu bundle). El paquete declara Node.js 22.13 o superior en `engines`. Incluye las declaraciones de TypeScript.

La publicación en npm llegará pronto. Mientras tanto, instala el paquete desde el archivo de la release de GitHub:

```bash
npm install https://github.com/jmmana/Agent-Viewer/releases/download/v0.2.1/warlockcode-agent-viewer-0.2.1.tgz
```

El nombre del paquete es `@warlockcode/agent-viewer` en ambos casos, así que tus importaciones no cambian cuando pases al registro de npm.

## Importa los estilos

La librería no inyecta CSS. Importa la hoja de estilos una vez, por ejemplo en la entrada de tu app:

```ts
import '@warlockcode/agent-viewer/style.css';
```

La hoja de estilos no trae reset ni preflight, ni selectores globales. Todas las clases empiezan por `av-`, el tema vive en propiedades personalizadas `--av-*` que puedes sobrescribir y no se cargan fuentes externas. Consulta [Temas y estilos](#temas-y-estilos).

`<AgentOffice>` ocupa todo su contenedor (`width: 100%; height: 100%`, con al menos 320 px de alto), así que dale una altura al contenedor.

## Ejemplo mínimo

El ejemplo usa datos sintéticos. Registra dos agentes con perfiles y envía dos eventos.

```tsx
import { AgentOffice, type AgentProfile, type OfficeEventInput } from '@warlockcode/agent-viewer';
import '@warlockcode/agent-viewer/style.css';

// Definidos fuera del componente, así los arreglos conservan la misma identidad en cada render.
const agents: AgentProfile[] = [
  { id: 'planner', name: 'Nova', roleTitle: 'Planificadora', workspace: 'leads_area', avatarColor: '#38bdf8' },
  { id: 'builder', name: 'Atlas', roleTitle: 'Desarrollador', workspace: 'development', avatarColor: '#f472b6' },
];

const events: OfficeEventInput[] = [
  {
    schemaVersion: '1.0',
    id: 'evt-001',
    type: 'agent.status.changed',
    timestamp: 1767225600000,
    source: 'agent:builder',
    agentId: 'builder',
    summary: 'Atlas empieza a programar',
    payload: { status: 'CODING', statusText: 'Escribiendo el parser' },
  },
  {
    schemaVersion: '1.0',
    id: 'evt-002',
    type: 'agent.message.sent',
    timestamp: 1767225601000,
    source: 'agent:planner',
    agentId: 'planner',
    summary: 'Nova propone un orden',
    payload: { text: 'Primero el parser y después el exportador.', kind: 'proposal', targetAgentId: 'builder' },
  },
];

export function OficinaDelEquipo() {
  return (
    <div style={{ height: 520 }}>
      <AgentOffice agents={agents} events={events} locale="es" theme="dark" />
    </div>
  );
}
```

Atlas aparece en un puesto de Ingeniería con el estado "Programando". Nova aparece en Arquitectura con una burbuja encabezada `Nova → Atlas · PROPONE` durante 6,5 segundos.

## Eventos en vivo

`<AgentOffice>` se controla con la prop `events`. Para mostrar actividad en vivo, agrega cada evento nuevo al final del arreglo y pasa el arreglo nuevo. La oficina aplica solo los eventos nuevos; cualquier otro cambio en la lista (otra ejecución, un tramo más corto) la reconstruye desde cero.

```tsx
import { useEffect, useState } from 'react';
import { AgentOffice, connectEventStream, type OfficeEventInput } from '@warlockcode/agent-viewer';

export function OficinaEnVivo() {
  const [events, setEvents] = useState<OfficeEventInput[]>([]);

  useEffect(() => {
    const connection = connectEventStream('http://localhost:8787', (event) => {
      setEvents((list) => [...list, event]);
    });
    return () => connection.close();
  }, []);

  return (
    <div style={{ height: 600 }}>
      <AgentOffice events={events} locale="es" />
    </div>
  );
}
```

Los eventos pueden venir de cualquier parte: tu propio WebSocket, un sondeo periódico, un store. `connectEventStream` es una ayuda para el stream Server-Sent Events de un servidor Agent Viewer (`GET /api/v1/events/stream`), descrita en la [Referencia de la API](#referencia-de-la-api).

La identidad importa, porque el componente compara referencias:

- `events`: pasa un arreglo nuevo cuando cambie (`[...list, event]`). Si modificas el mismo arreglo, el cambio no se detecta.
- `agents`: conserva el mismo arreglo entre renders (una constante del módulo, estado o `useMemo`). Un arreglo nuevo reconstruye la oficina.
- `messages` y `t`: memorízalos. Un objeto o una función nuevos en cada render reconstruyen el traductor y reinician el ciclo de dibujo del canvas.

Dale a cada evento un `id` estable y único. La oficina ignora un evento cuyo `id` ya aplicó, y usa los ids para distinguir una lista que creció de una lista distinta.

## Props de `<AgentOffice>`

| Prop | Tipo | Valor por defecto | Descripción |
|---|---|---|---|
| `events` | `readonly OfficeEventInput[]` | `[]` | La fuente de verdad. La oficina se deriva solo de estos eventos. Agrega eventos para la actividad en vivo o pasa un tramo de una ejecución grabada para repetirla. |
| `agents` | `readonly AgentProfile[]` | ninguno | Agentes conocidos antes de su primer evento. Cada perfil equivale a un evento `agent.registered`. |
| `mode` | `'professional' \| 'showcase'` | `'professional'` | Consulta [Modos](#modos). |
| `locale` | `string` | `'en'` | Locale BCP 47, como `es-CO`. Elige los textos incluidos (`es…` usa español; cualquier otro, inglés) y el formato de los números de consumo. |
| `messages` | `Partial<OfficeMessages>` | ninguno | Reemplazos de textos sueltos. Memorízalo. Consulta [Traducciones](#traducciones). |
| `t` | `HostTranslate` | ninguno | Tu función de traducción. Gana sobre `messages` cuando devuelve un valor. Mantenla estable. |
| `theme` | `'dark' \| 'light'` | `'dark'` | Paleta del dibujo del canvas y clase `av-theme-dark` o `av-theme-light`. |
| `showUsage` | `boolean` | `false` | Muestra las cifras que pasas en `usage`. Consulta [Cifras de consumo](#cifras-de-consumo). |
| `showUsageBadges` | `boolean` | `false` | Dibuja una insignia compacta de consumo en cada tarjeta de agente, a partir de `usage.byAgent`. Independiente de `showUsage`. Consulta [Cifras de consumo](#cifras-de-consumo). |
| `usage` | `OfficeUsage` | ninguno | Cifras de consumo calculadas por tu app. La oficina nunca las calcula. |
| `showCallDetails` | `boolean` | `false` | Muestra un panel de solo lectura con las llamadas del agente seleccionado, a partir de `agentCallDetails`. Independiente de `showUsage`/`showUsageBadges`. Consulta [Detalle de llamadas](#detalle-de-llamadas). |
| `agentCallDetails` | `AgentCallDetails` | ninguno | Metadatos de llamadas por id de agente, calculados y paginados por tu app. Solo se lee la entrada del agente seleccionado. |
| `selectedAgentId` | `string \| null` | ninguno | Selección controlada. Déjala sin definir para que la oficina lleve la suya. Cuando cambia, la cámara se centra en ese agente. |
| `onSelectAgent` | `(agentId: string \| null) => void` | ninguno | Se llama cuando quien mira hace clic en un agente del canvas, lo elige de la lista de agentes, o cierra el panel de detalle de llamadas (botón de cerrar o `Escape`). |
| `bubbleDurationMs` | `number` | `6500` | Cuánto tiempo se ve una burbuja, en milisegundos. |
| `className` | `string` | ninguno | Clase adicional para la raíz `<section class="av-office av-theme-…">`. |
| `style` | `React.CSSProperties` | ninguno | Estilos en línea para la raíz. |
| `ariaLabel` | `string` | texto de `office.label` | Nombre accesible de la región de la oficina. |

`AgentProfile`:

| Campo | Tipo | Descripción |
|---|---|---|
| `id` | `string` | Id del agente, el mismo que usan tus eventos en `agentId`. Obligatorio. |
| `name` | `string` | Nombre visible. Obligatorio. |
| `roleTitle` | `string` | Texto libre que aparece en la tarjeta del nombre, por ejemplo `Planificadora`. |
| `team` | `'leadership' \| 'engineering' \| 'research' \| 'quality' \| 'operations' \| 'other'` | Equipo del agente. |
| `workspace` | `WorkspaceZone` | Sala donde se sienta el agente. Consulta [Espacios de trabajo](#espacios-de-trabajo). |
| `avatarColor` | `string` | Color hexadecimal, por ejemplo `#38bdf8`. Otros valores se ignoran. |

Controles del canvas: la barra de la izquierda gira la oficina, la ajusta a la vista y acerca o aleja. También se puede arrastrar para desplazar la vista y usar la rueda del ratón para el zoom. Un clic en un agente lo selecciona.

## Modos

| Modo | Qué muestra la oficina |
|---|---|
| `professional` (por defecto) | Solo lo que dicen los eventos. Sin vida ambiental, sin frases inventadas, sin segundo piso oculto y sin sonidos. Cuando se pide una reunión, los participantes solo caminan a la sala. |
| `showcase` | Agrega vida de oficina simulada para demos. Los agentes que siguen inactivos van por café y charlan en conversaciones cortas simuladas. Esas burbujas llevan el encabezado `SOCIAL · SIMULADO` y nunca cambian el estado de trabajo del agente. Las solicitudes de reunión nunca reciben frases inventadas, en ningún modo. |

El idioma de las conversaciones simuladas sigue a `locale` (español o inglés).

## Cómo cambian la oficina los eventos

Los eventos siguen el contrato canónico V1 (consulta [integration.md](integration.md) y [`canonicalContract.ts`](../src/integrations/canonicalContract.ts)). La oficina lee `id`, `type`, `timestamp` (milisegundos), `source`, `agentId`, `taskId`, `summary` y `payload`. Los campos del sobre que falten se completan con tolerancia; usa `validateCanonicalEvent` si quieres una validación estricta.

El agente de un evento es `agentId`; si falta, `payload.agentId`; luego `payload.id` en los eventos `agent.*`, y por último un `source` con la forma `agent:<id>`.

| Evento | Campos del payload que lee | Efecto en la oficina |
|---|---|---|
| `agent.registered` | `name`, `roleTitle`, `role`, `team`, `workspace`, `avatarColor` (hex), `status`, `statusText`, `provider`, `model`, `managerId` | Agrega el agente, o lo actualiza si ya existe. Un agente nuevo aparece directamente en su espacio de trabajo; uno existente camina hasta allí. Un `status` válido fija el estado inicial. |
| `agent.updated` | `name`, `roleTitle`, `provider`, `model`, `statusText`, `workspace` | Actualiza el perfil. Con un `workspace` válido, el agente camina hasta allí y lo toma como su sitio. |
| `agent.status.changed` | `status`, `statusText`, `workspace` | Cambia el estado (sin distinguir mayúsculas; los estados desconocidos se ignoran). El agente solo se mueve si llega un `workspace` válido. |
| `agent.message.sent` | `text`, `kind`, `targetAgentId`, `targetAgentName` | Muestra una burbuja. Con destinatario, el encabezado lo nombra y una línea punteada une a los dos agentes. |
| `meeting.requested` | `participantIds`, `meetingId`, `title`, `topic` | Reserva la primera sala de reuniones libre para el grupo. Los participantes pasan a `WALKING` y caminan a sus sillas; la reunión empieza cuando todos llegan y pasan a `IN_MEETING`. |
| `meeting.started` | `meetingId`, `participantIds`, `title` | Inicia de inmediato una reunión pedida, sin esperar a que todos lleguen. Si el `meetingId` es desconocido y llega `participantIds`, la reunión se pide y se inicia. |
| `meeting.message` | `text`, `type`, `meetingId`, `targetAgentId`, `targetAgentName` | Muestra una burbuja encabezada por el tipo de mensaje y guarda el mensaje en la reunión (la activa si falta `meetingId`). Un `decision` también se agrega a las decisiones de la reunión. |
| `meeting.ended`, `meeting.cancelled` | `meetingId` | Termina la reunión y libera la sala. Los participantes pasan a `IDLE` y vuelven caminando a su espacio de trabajo. |
| `tool.started` | `tool`, `inputSummary` | Estado `USING_TOOL`. |
| `tool.completed` | `tool`, `outputSummary` | Estado `IDLE`. |
| `tool.failed` | `tool`, `error` | Estado `ERROR`. |
| `task.created`, `task.assigned` | `id` o `taskId`, `title`, `assignedAgentId` | Se registra; sin cambio visible. |
| `task.progress` | `taskId`, `progress` | La tarea pasa a ser la tarea actual del agente; sin cambio visible. |
| `task.completed` | `taskId` | Estado `DONE` si era la tarea actual del agente. |
| `task.failed` | `taskId`, `error` | Estado `ERROR` si era la tarea actual del agente. |
| `task.blocked` | `taskId`, `reason` | Estado `BLOCKED`. |
| `llm.usage` | `provider`, `model` | Guarda el proveedor y el modelo del agente. Los tokens y el costo no se suman (consulta [Cifras de consumo](#cifras-de-consumo)). |
| `llm.failed` | `provider`, `model` | Guarda el proveedor y el modelo del agente. Sin cambio de estado; los tokens y el costo nunca se suman. |
| `runtime.connected`, `runtime.disconnected`, `runtime.heartbeat` | ninguno | Sin cambio visible. |

Más detalles:

- **Estados.** `OFFLINE`, `IDLE`, `AVAILABLE`, `THINKING`, `READING`, `RESEARCHING`, `CODING`, `WRITING`, `TESTING`, `USING_TOOL`, `WAITING`, `WAITING_APPROVAL`, `BLOCKED`, `DELEGATING`, `PHONE_CALL`, `WALKING`, `IN_MEETING`, `COFFEE_BREAK`, `CHATTING`, `REVIEWING`, `DELIVERING`, `DONE`, `ERROR`.
- **Agentes que la oficina aún no conoce.** Un evento de un agente desconocido lo agrega con un perfil por defecto (su id como nombre). Un `agentId` explícito siempre nombra a un agente, sea cual sea el `source`. Un evento con `source` `runtime:` y sin `agentId` habla del runtime mismo y no agrega agentes. Registrar primero a los agentes (con `agent.registered` o con la prop `agents`) les da su nombre real, su cargo y su espacio de trabajo.
- **Roles.** `role` acepta los roles del equipo de la demo (`boss`, `tech_lead`, `research_lead`, `backend_engineer`, `frontend_engineer`, `qa_engineer`, `security_analyst`) y por defecto es `custom`. Un agente `custom` muestra su `roleTitle`; los demás roles muestran su texto `role.*`, y `boss` muestra el texto de `role.boss` en lugar del nombre.
- **Salas de reuniones.** La Sala de reunión A, la Sala de reunión B y, como respaldo, la Dirección, con 4 sillas cada una. Si no hay sala libre o el grupo tiene más de 4 participantes, la reunión empieza de inmediato y los participantes se quedan donde están.
- **Después de una reunión** cada participante vuelve al espacio de trabajo de su perfil. Un agente sin espacio de trabajo vuelve a donde estaba antes de la reunión.
- **Alias.** `message.sent` se lee como `agent.message.sent`; `agent.phone_call.started` y `meeting.room.reserved` como `meeting.started`; `agent.phone_call.ended` como `meeting.ended`; `meeting.decision` como `meeting.message`; `task.started`, `approval.approved` y `artifact.created` como `task.progress`; `approval.requested` como `task.blocked`.
- **Tiempos.** Cuando llegan varios eventos juntos (el primer render, una reconstrucción, un salto en la repetición), conservan sus tiempos relativos: un evento 10 segundos más antiguo que el más reciente se aplica como si hubiera ocurrido hace 10 segundos. Por eso, al reconstruir una ejecución larga solo se ven las burbujas y los desplazamientos recientes.

## Tipos de mensaje y burbujas

`MESSAGE_KINDS` enumera lo que hace un mensaje dentro de una conversación:

| Tipo | Encabezado en español | Encabezado en inglés |
|---|---|---|
| `statement` | DICE | SAYS |
| `proposal` | PROPONE | PROPOSES |
| `question` | PREGUNTA | ASKS |
| `answer` | RESPONDE | ANSWERS |
| `objection` | OBJETA | OBJECTS |
| `critique` | CRITICA | CRITIQUES |
| `agreement` | ACUERDA | AGREES |
| `summary` | RESUME | SUMMARIZES |
| `decision` | DECIDE | DECIDES |

- `meeting.message` lleva el tipo en `payload.type`. Es opcional y por defecto vale `statement`.
- `agent.message.sent` acepta un `payload.kind` opcional. La oficina nunca adivina el tipo: sin él, el encabezado sigue el estado del agente (`REUNIÓN` en una reunión, `LLAMADA` en una llamada, `SOCIAL · SIMULADO` en las charlas simuladas del modo showcase y `ACTIVIDAD` en los demás casos).

Una burbuja se lee `Hablante · ENCABEZADO`, o `Hablante → Destinatario · ENCABEZADO` cuando el mensaje tiene destinatario. El hablante es la primera palabra del nombre del agente. El texto ocupa como máximo dos líneas y termina en puntos suspensivos si es más largo. Cada agente muestra una burbuja a la vez: un mensaje nuevo reemplaza al anterior y se ve durante `bubbleDurationMs`.

## Espacios de trabajo

`workspace` (en `agent.registered`, `agent.updated`, `agent.status.changed` y `AgentProfile`) acepta estos valores. Cualquier otro valor se ignora y el agente se queda donde está.

| Espacio de trabajo | Rótulo de la sala (es) | Rótulo de la sala (en) |
|---|---|---|
| `boss_office` | DIRECCIÓN | DIRECTOR SUITE |
| `leads_area` | ARQUITECTURA | ARCHITECTURE |
| `development` | INGENIERÍA | ENGINEERING |
| `qa_lab` | LAB QA | QA LAB |
| `research_area` | BIBLIOTECA I+D | RESEARCH LIBRARY |
| `server_room` | MODEL OPS | MODEL OPS |
| `meeting_room` | SALA DE REUNIÓN A | MEETING ROOM A |
| `meeting_room_b` | SALA DE REUNIÓN B | MEETING ROOM B |
| `break_room` | CAFÉ ESPRESSO | ESPRESSO BAR |

`overflow_floor` también se acepta: es el punto de la escalera del segundo piso de la app de demostración. La oficina embebida no tiene segundo piso, así que usa una de las salas anteriores. Los agentes que comparten sala se colocan uno al lado del otro.

## Traducciones

Todo texto visible sale de un catálogo de claves. El inglés y el español vienen incluidos, y puedes renombrar o traducir cualquier cosa:

- `locale` elige el catálogo incluido: un locale que empieza por `es` (`es`, `es-CO`, `es-MX`...) usa español; cualquier otro, inglés.
- `messages` reemplaza claves sueltas: `{ 'rooms.development': 'EQUIPO DE PLATAFORMA' }`.
- `t` conecta tu propia función de traducción (i18next, FormatJS y similares).

Para cada clave, la oficina usa lo primero que encuentre de esta lista:

1. `t(key, params)`, si devuelve un texto no vacío y distinto de la clave. El texto se usa tal cual, así que `t` debe rellenar los marcadores por su cuenta.
2. `messages[key]`.
3. El catálogo incluido del `locale`.
4. El catálogo en inglés.

Los marcadores usan `{name}` y los rellena `formatMessage`. Un marcador sin valor se queda tal como está escrito.

```tsx
const messages = useMemo(() => ({ 'rooms.development': 'EQUIPO DE PLATAFORMA', 'office.empty': 'Aún no hay agentes' }), []);

<AgentOffice events={events} locale="es" messages={messages} />
```

Con i18next, guarda las claves de la oficina bajo un prefijo propio y responde solo las claves que tengas:

```tsx
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { HostTranslate } from '@warlockcode/agent-viewer';

const { t, i18n } = useTranslation();
const officeT = useCallback<HostTranslate>(
  (key, params) => (i18n.exists(`office.${key}`) ? t(`office.${key}`, params) : undefined),
  [i18n, t],
);

<AgentOffice events={events} locale={i18n.language} t={officeT} />
```

`ReplayControls` y `recordReplay` aceptan los mismos `locale`, `messages` y `t`. `createOfficeTranslator({ locale, messages, t })` devuelve la misma función de traducción que usan los componentes, `builtInMessages(locale)` devuelve un catálogo incluido, `OFFICE_MESSAGES` contiene los dos catálogos (`en`, `es`) e `isOfficeMessageKey(key)` comprueba una clave.

### Claves de texto

Hay 116 claves. Las claves `screen.tokenFlow`, `screen.telemetry`, `screen.open`, `canvas.modelOps`, `canvas.showTimeline`, `canvas.hideTimeline` y `modelOps.*` pertenecen a la consola Model Ops y a la línea de tiempo de la app de demostración; la oficina embebida no las muestra. Desde el issue #79, Model Ops lee el ledger de uso del servidor: ese cliente de lectura y sus componentes de pestañas basados en el ledger viven en `src/integrations/ledgerClient.ts` y `src/components/modelOps/`, ambos exclusivos de la app de demostración. `@warlockcode/agent-viewer` no incluye ningún cliente de ledger, ninguna referencia al endpoint del ledger de uso ni ningún componente de Model Ops (verificado por `tests/lib/libraryIsolation.test.ts`).

#### `rooms.*` (10)

| Clave | Texto en español | Texto en inglés |
|---|---|---|
| `rooms.boss_office` | DIRECCIÓN | DIRECTOR SUITE |
| `rooms.meeting_room` | SALA DE REUNIÓN A | MEETING ROOM A |
| `rooms.meeting_room_b` | SALA DE REUNIÓN B | MEETING ROOM B |
| `rooms.server_room` | MODEL OPS | MODEL OPS |
| `rooms.leads_area` | ARQUITECTURA | ARCHITECTURE |
| `rooms.development` | INGENIERÍA | ENGINEERING |
| `rooms.qa_lab` | LAB QA | QA LAB |
| `rooms.research_area` | BIBLIOTECA I+D | RESEARCH LIBRARY |
| `rooms.break_room` | CAFÉ ESPRESSO | ESPRESSO BAR |
| `rooms.lounge` | SALA DEL EQUIPO | TEAM LOUNGE |

#### `furniture.*` (6)

| Clave | Texto en español | Texto en inglés |
|---|---|---|
| `furniture.f_boss_screen` | Muro de objetivos | Objectives Wall |
| `furniture.f_server_desk` | Telemetría de tokens | Token Telemetry |
| `furniture.f_research_table` | Mesa de estudio | Study Table |
| `furniture.f_coffee_table_a` | Mesa A | Table A |
| `furniture.f_coffee_table_b` | Mesa B | Table B |
| `furniture.f_lounge_screen` | Pantalla del salón | Lounge Display |

#### `screen.*` (7)

| Clave | Texto en español | Texto en inglés |
|---|---|---|
| `screen.meetingActive` | COORDINACIÓN | TEAM COORDINATION |
| `screen.meetingIdle` | SALA LISTA | CONFERENCE READY |
| `screen.qa` | PRUEBAS AUTOMÁTICAS | TEST AUTOMATION |
| `screen.status` | ESTADO DEL SISTEMA | SYSTEM STATUS |
| `screen.tokenFlow` | MODEL OPS · FLUJO DE TOKENS | MODEL OPS · LIVE TOKEN FLOW |
| `screen.telemetry` | MODEL OPS · TELEMETRÍA | MODEL OPS · LIVE TELEMETRY |
| `screen.open` | ABRIR | OPEN |

#### `status.*` (23)

| Clave | Texto en español | Texto en inglés |
|---|---|---|
| `status.OFFLINE` | Desconectado | Offline |
| `status.IDLE` | En espera | Idle |
| `status.AVAILABLE` | Disponible | Available |
| `status.THINKING` | Pensando | Thinking |
| `status.READING` | Leyendo | Reading |
| `status.RESEARCHING` | Investigando | Researching |
| `status.CODING` | Programando | Coding |
| `status.WRITING` | Escribiendo | Writing |
| `status.TESTING` | Probando | Testing |
| `status.USING_TOOL` | Usando una herramienta | Using a tool |
| `status.WAITING` | Esperando | Waiting |
| `status.WAITING_APPROVAL` | Esperando aprobación | Waiting for approval |
| `status.BLOCKED` | Bloqueado | Blocked |
| `status.DELEGATING` | Delegando | Delegating |
| `status.PHONE_CALL` | En llamada | On a call |
| `status.WALKING` | Caminando | Walking |
| `status.IN_MEETING` | En reunión | In a meeting |
| `status.COFFEE_BREAK` | Pausa para café | Coffee break |
| `status.CHATTING` | Conversando | Chatting |
| `status.REVIEWING` | Revisando | Reviewing |
| `status.DELIVERING` | Entregando | Delivering |
| `status.DONE` | Terminado | Done |
| `status.ERROR` | Error | Error |

#### `role.*` (8)

| Clave | Texto en español | Texto en inglés |
|---|---|---|
| `role.boss` | Dirección | Director |
| `role.tech_lead` | Líder técnico | Tech lead |
| `role.research_lead` | Investigación | Research |
| `role.backend_engineer` | Backend | Backend |
| `role.frontend_engineer` | Frontend | Frontend |
| `role.qa_engineer` | QA | QA |
| `role.security_analyst` | Seguridad | Security |
| `role.custom` | Agente | Agent |

#### `bubble.*` (4)

| Clave | Texto en español | Texto en inglés |
|---|---|---|
| `bubble.meeting` | REUNIÓN | MEETING |
| `bubble.phone` | LLAMADA | CALL |
| `bubble.social` | SOCIAL · SIMULADO | SOCIAL · SIMULATED |
| `bubble.activity` | ACTIVIDAD | ACTIVITY |

#### `kind.*` (9)

| Clave | Texto en español | Texto en inglés |
|---|---|---|
| `kind.statement` | DICE | SAYS |
| `kind.proposal` | PROPONE | PROPOSES |
| `kind.question` | PREGUNTA | ASKS |
| `kind.answer` | RESPONDE | ANSWERS |
| `kind.objection` | OBJETA | OBJECTS |
| `kind.critique` | CRITICA | CRITIQUES |
| `kind.agreement` | ACUERDA | AGREES |
| `kind.summary` | RESUME | SUMMARIZES |
| `kind.decision` | DECIDE | DECIDES |

#### `canvas.*` (11)

| Clave | Texto en español | Texto en inglés |
|---|---|---|
| `canvas.aria` | Oficina animada de agentes. La lista de agentes y su estado está disponible como texto. | Animated agent office. The list of agents and their status is available as text. |
| `canvas.toolbar` | Controles de la vista | Office view controls |
| `canvas.rotateLeft` | Girar oficina a la izquierda | Rotate office left |
| `canvas.rotateRight` | Girar oficina a la derecha | Rotate office right |
| `canvas.fit` | Ajustar oficina completa | Fit full office |
| `canvas.zoomOut` | Alejar | Zoom out |
| `canvas.zoomIn` | Acercar | Zoom in |
| `canvas.zoomLevel` | Zoom {percent}% | Zoom {percent}% |
| `canvas.showTimeline` | Mostrar actividad | Show activity timeline |
| `canvas.hideTimeline` | Ocultar actividad | Hide activity timeline |
| `canvas.modelOps` | Consola Model Ops (tokens y telemetría) | Model Ops console (tokens and telemetry) |

#### `modelOps.*` (18)

| Clave | Texto en español | Texto en inglés |
|---|---|---|
| `modelOps.rack.openai` | Nodo servidor OpenAI | OpenAI server node |
| `modelOps.rack.openaiDetail` | Tokens de prompts y razonamiento | Prompt and reasoning tokens |
| `modelOps.rack.anthropic` | Nodo servidor Anthropic | Anthropic server node |
| `modelOps.rack.anthropicDetail` | Código e interfaz | Code and UI work |
| `modelOps.rack.gemini` | Nodo servidor Google Gemini | Google Gemini server node |
| `modelOps.rack.geminiDetail` | Trabajo con contexto largo | Long context work |
| `modelOps.rack.local` | Rack local on-premise | On-premise local rack |
| `modelOps.rack.localDetail` | Cómputo local sin costo de nube | Local compute without cloud cost |
| `modelOps.noc` | Pantalla central Model Ops | Model Ops central screen |
| `modelOps.nocDetail` | Flujo global de tokens en vivo | Live view of the global token flow |
| `modelOps.workstation` | Estación de telemetría Model Ops | Model Ops telemetry workstation |
| `modelOps.workstationDetail` | Monitoreo de latencia, caché y rendimiento | Latency, cache and throughput monitoring |
| `modelOps.plaque` | Consola central de operaciones | Central operations console |
| `modelOps.plaqueDetail` | Abrir el panel interactivo de consumo de tokens | Open the interactive token usage panel |
| `modelOps.room` | Sala Model Ops y centro de tokens | Model Ops and token center |
| `modelOps.roomDetail` | Infraestructura LLM y monitoreo de consumo | LLM infrastructure and usage monitoring |
| `modelOps.open` | Abrir consola Model Ops | Open Model Ops console |
| `modelOps.hint` | Haz clic para revisar el consumo de tokens | Click to inspect token usage |

#### `office.*` (5)

| Clave | Texto en español | Texto en inglés |
|---|---|---|
| `office.label` | Oficina de agentes | Agent office |
| `office.agentsHeading` | Agentes en la oficina | Agents in the office |
| `office.agentLine` | {name}, {role}: {status} | {name}, {role}: {status} |
| `office.agentLineNoRole` | {name}: {status} | {name}: {status} |
| `office.empty` | Esperando actividad de los agentes | Waiting for agent activity |

#### `usage.*` (26)

| Clave | Texto en español | Texto en inglés |
|---|---|---|
| `usage.title` | Consumo | Usage |
| `usage.tokens` | Tokens | Tokens |
| `usage.inputTokens` | Tokens de entrada | Input tokens |
| `usage.outputTokens` | Tokens de salida | Output tokens |
| `usage.cacheRead` | Lectura de caché | Cache read |
| `usage.cacheWrite` | Escritura de caché | Cache write |
| `usage.cacheReadTokens` | Tokens de caché leídos | Cache read tokens |
| `usage.cacheWriteTokens` | Tokens de caché escritos | Cache write tokens |
| `usage.reasoningTokens` | Tokens de razonamiento | Reasoning tokens |
| `usage.cost` | Costo | Cost |
| `usage.costSource` | Origen del costo | Cost source |
| `usage.costSource.providerReported` | informado por el proveedor | provider reported |
| `usage.costSource.estimated` | estimado | estimated |
| `usage.failedCalls` | Llamadas fallidas | Failed calls |
| `usage.badge.estimatedMark` | est. | est. |
| `usage.badge.failed` | {count} fallidas | {count} failed |
| `usage.badge.lessThan` | <{value} | <{value} |
| `usage.unknown` | desconocido | unknown |
| `usage.partialTokens` | {value} (desconocido en {count} de {calls} llamadas) | {value} (unknown in {count} of {calls} calls) |
| `usage.partialCost` | + {count} llamadas con costo desconocido | + {count} calls with unknown cost |
| `usage.partialShort` | + desconocido | + unknown |
| `usage.mixedCurrencies` | múltiples monedas | mixed currencies |
| `usage.mixedSources` | múltiples fuentes | mixed sources |
| `usage.noCurrency` | Moneda no reportada | Currency not reported |
| `usage.estimatedShort` | estimado | estimated |
| `usage.sourceUnknown` | Fuente desconocida | Source unknown |

#### `replay.*` (8)

| Clave | Texto en español | Texto en inglés |
|---|---|---|
| `replay.label` | Controles de repetición | Replay controls |
| `replay.play` | Reproducir | Play |
| `replay.pause` | Pausar | Pause |
| `replay.reset` | Volver al inicio | Back to start |
| `replay.position` | Posición de la repetición | Replay position |
| `replay.progress` | {percent}% | {percent}% |
| `replay.speed` | Velocidad | Speed |
| `replay.speedValue` | {speed}x | {speed}x |

#### `video.*` (1)

| Clave | Texto en español | Texto en inglés |
|---|---|---|
| `video.time` | Hora: {time} | Time: {time} |

## Temas y estilos

`theme="dark"` o `theme="light"` elige la paleta. Las partes HTML de la oficina (barra del canvas, panel de consumo, estado vacío, controles de repetición) leen propiedades personalizadas `--av-*`. Están declaradas con especificidad cero (`:where(...)`), así que cualquier selector tuyo les gana.

Variables del tema:

| Variable | Oscuro | Claro | Uso |
|---|---|---|---|
| `--av-bg` | `#090d16` | `#f8fafc` | Fondo de la oficina y del área del canvas. |
| `--av-surface` | `#0f172a` | `#ffffff` | Barra de herramientas y botones de repetición. |
| `--av-surface-raised` | `rgba(15, 23, 42, 0.94)` | `rgba(255, 255, 255, 0.96)` | Paneles flotantes: consumo, estado vacío, barra de repetición, tooltip. |
| `--av-border` | `#1e293b` | `#e2e8f0` | Bordes de paneles, separadores de la barra, hover de sus botones. |
| `--av-border-strong` | `#334155` | `#cbd5e1` | Bordes de botones, borde del estado vacío, selector de velocidad. |
| `--av-text` | `#f1f5f9` | `#0f172a` | Texto principal. |
| `--av-text-muted` | `#94a3b8` | `#475569` | Texto secundario e iconos de la barra. |
| `--av-accent` | `#38bdf8` | `#0284c7` | Botón de ajustar, barra de posición, anillo de foco. |
| `--av-accent-strong` | `#0ea5e9` | `#0369a1` | Botón de reproducir y velocidad elegida. |
| `--av-accent-contrast` | `#0f172a` | `#ffffff` | Texto e iconos sobre `--av-accent-strong`. |
| `--av-telemetry` | `#22d3ee` | `#0e7490` | Botón y tooltip de telemetría de la app de demostración. |
| `--av-live` | `#34d399` | `#059669` | Indicador en vivo de la app de demostración. |
| `--av-active` | `#4f46e5` | `#4f46e5` | Botón presionado de la barra. |
| `--av-shadow` | `0 12px 32px rgba(0, 0, 0, 0.35)` | `0 12px 32px rgba(15, 23, 42, 0.12)` | Sombra de los paneles flotantes. |

Variables compartidas (ambos temas):

| Variable | Valor por defecto | Uso |
|---|---|---|
| `--av-radius` | `12px` | Radio de las esquinas de los paneles. |
| `--av-font-sans` | `system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif` | Texto de las partes HTML. |
| `--av-font-mono` | `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` | Números y nivel de zoom. |
| `--av-focus` | `2px solid var(--av-accent)` | Contorno de foco de botones y de la barra de posición. |

Para sobrescribirlas, agrega una clase con `className` y define las variables en ella. La oficina declara el tema una sola vez, en su raíz, así que la barra de herramientas y todos los paneles de adentro heredan tus valores:

```css
.oficina-equipo,
.repeticion-equipo {
  --av-accent: #7c3aed;
  --av-accent-strong: #6d28d9;
  --av-radius: 8px;
}
```

```tsx
<>
  <AgentOffice className="oficina-equipo" events={events} />
  <ReplayControls className="repeticion-equipo" replay={replay} />
</>
```

Notas:

- El dibujo del canvas (piso, muebles, agentes, tarjetas de nombre y burbujas) usa la paleta oscura o clara que elige `theme`. Las variables `--av-*` no lo cambian.
- No se carga ninguna fuente. El texto del canvas pide `"Plus Jakarta Sans"` y usa la fuente sans-serif del navegador si tu página no la ofrece.
- Clases a las que puedes apuntar: `av-office`, `av-theme-dark`, `av-theme-light`, `av-office-stage`, `av-office-empty`, `av-usage`, `av-usage-item`, `av-sr-only`, `av-canvas-root`, `av-toolbar`, `av-toolbar-sep`, `av-tool-btn`, `av-tool-btn--accent`, `av-tool-btn--active`, `av-zoom-level`, `av-stage`, `av-canvas`, `av-icon`, `av-replay`, `av-replay-btn`, `av-replay-btn--primary`, `av-replay-range`, `av-replay-progress`, `av-replay-speed`, `av-call-details`, `av-call-details-header`, `av-call-details-close`, `av-call-details-empty`, `av-call-details-list`, `av-call-item`, `av-call-row`, `av-call-request-id`. Las clases `av-tooltip*`, `av-tool-btn--telemetry` y `av-icon--live` las usa la app de demostración.

## Accesibilidad

- La oficina es un `<section>` con el nombre de `ariaLabel` (por defecto, el texto de `office.label`).
- El canvas tiene `role="img"` y un `aria-label` (`canvas.aria`) que remite a la lista en texto.
- Una lista oculta a la vista y anunciada con cortesía (`aria-live="polite"`) nombra a cada agente con su rol y su estado, por ejemplo "Atlas, Desarrollador: Programando". Con `showUsage` o `showUsageBadges` (cualquiera de los dos), cada línea incluye además las cifras exactas de ese agente en `usage.byAgent`, así que el texto para lector de pantalla siempre coincide con una insignia visible, incluso cuando la insignia misma está oculta por debajo del zoom 0.55. La lista queda oculta a la vista hasta que recibe el foco del teclado (Tab); entonces se abre como un panel de botones.
- La barra (`role="toolbar"`) y los controles de repetición son botones reales con nombre accesible y anillo de foco visible. La barra de posición anuncia el avance y los botones de velocidad usan `aria-pressed`.
- Con `prefers-reduced-motion: reduce` nada se anima: los agentes llegan a su destino sin caminar, los detalles animados se quedan quietos y las transiciones de los botones se desactivan.
- Selección con teclado: cada agente de esa lista es un botón (`aria-pressed` marca el seleccionado). Al pulsarlo se selecciona el agente y la cámara va hacia él, igual que con un clic en el canvas; al pulsarlo otra vez se quita la selección. La oficina no registra atajos de teclado globales, salvo `Escape` dentro del panel de detalle de llamadas abierto (`showCallDetails`), que solo cierra ese panel.

## Cifras de consumo

La oficina nunca calcula, suma ni pone precio al consumo. Solo muestra las cifras que le pasa tu app, y solo cuando lo pides:

```tsx
const usage = useMemo(() => ({
  total: { totalTokens: 18400, inputTokens: 15200, outputTokens: 3200, cost: 0.42, currency: 'USD' },
  byAgent: {
    planner: { totalTokens: 6100, cost: null },
    builder: { totalTokens: 12300, cost: 0.42, currency: 'USD' },
  },
}), []);

<AgentOffice events={events} locale="es" showUsage usage={usage} />
```

`OfficeUsage` es `{ total?: UsageFigures; byAgent?: Record<string, UsageFigures> }`. `UsageFigures` tiene `totalTokens`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`, `cost`, `currency`, `costSource` (`'provider-reported' | 'estimated' | 'unknown'`) y `failedCalls` (todos opcionales y aceptan `null`).

Reglas de presentación:

- `showUsage` es `false` por defecto. Sin él, `usage` se ignora.
- `total` aparece en un panel pequeño en la esquina superior derecha: tokens y costo siempre; cada otro campo solo si envías esa clave.
- Las cifras de `byAgent`, indexadas por id de agente, aparecen en la lista accesible de agentes.
- Un valor que falta (`undefined`, `null` o un número no finito) se muestra como "desconocido" (`usage.unknown`), nunca como cero. `totalTokens` no se deriva de los tokens de entrada y de salida: envíalo tú.
- `cost` se muestra como moneda cuando `currency` es un código ISO 4217 como `USD` o `COP`, y como número simple en otro caso. Los números siguen a `locale`.
- `costSource` se muestra como "informado por el proveedor" o "estimado"; `null`, ausente o un valor no reconocido se muestra como desconocido. `failedCalls` sigue las mismas reglas de formato de tokens que cualquier otro conteo.

`formatUsage(figures, locale, translate)`, `formatTokens` y `formatCost` devuelven los mismos valores formateados, por si quieres mostrarlos en otra parte de tu interfaz.

### Insignias de consumo en el canvas

`showUsageBadges` (`false` por defecto, independiente de `showUsage`) dibuja una insignia compacta en cada tarjeta de agente a partir de `usage.byAgent`:

```tsx
<AgentOffice events={events} locale="es" usage={usage} showUsageBadges />
```

- Un agente **sin** entrada en `usage.byAgent` **no recibe insignia**: eso no es ni un cero ni una afirmación, así que la librería no dibuja nada en vez de adivinar. Un agente con una entrada cuyos campos faltan o son `null` recibe una insignia que dice "desconocido" en esos campos.
- La insignia muestra los tokens totales en forma compacta (`9.840` por debajo de 10.000, `12,3 mil` desde 10.000 en adelante), el costo (`$0,42`, `<$0,01` para un costo positivo menor a medio centavo, `$0,00` para un costo reportado en cero), la marca `est.` cuando `costSource` es `'estimated'`, y un chip `N fallidas` cuando `failedCalls` es mayor que 0. Nada de esto depende solo del color: cada estado tiene su propio texto.
- Las insignias viven en la tarjeta del agente, así que quedan ocultas por debajo del zoom 0.55 a menos que el agente esté seleccionado, resaltado o hablando, igual que la tarjeta misma. La lista accesible de agentes (arriba) es el canal siempre disponible con las cifras exactas.
- El canvas recibe solo las cadenas ya formateadas que produce `formatUsageBadge`, nunca un número: no importa el agregador de tokens de la app de demostración y no suma nada por su cuenta.
- `formatUsageBadge(figures, locale, translate)` devuelve `{ tokens, cost, costLabel, estimated, failed, text }` y se exporta por si quieres el mismo contenido de insignia en otra parte de tu interfaz; `UsageBadge` y `UsageCostSource` son tipos exportados.

Si tu app no tiene un servicio de consumo, `summarizeUsage(events)` es una ayuda opcional y explícita. Solo suma las cifras que reportan los eventos `llm.usage` y `llm.failed`, y nunca pone precio a los tokens:

```tsx
const usage = useMemo(() => summarizeUsage(events), [events]);
```

- Los eventos se deduplican por `id`, como lo hacen la oficina y el servidor: gana el primer evento con un id dado, sea cual sea su tipo o agente, y los siguientes con ese id se ignoran (las reconexiones SSE, los reintentos y los archivos de repetición combinados repiten eventos). Un evento sin `id` (o con uno vacío o que no es texto) no se puede emparejar, así que cada uno se cuenta; el mismo objeto pasado dos veces cuenta una sola vez.
- Los tokens se leen del payload original. Un conteo está reportado solo si es un entero no negativo. Si algún evento no reporta `inputTokens`, la cifra `inputTokens` es `null` (se muestra como "desconocido"), y lo mismo pasa con `outputTokens`. `totalTokens` es `inputTokens + outputTokens` solo si ambos se conocen, y `null` en otro caso.
- `cacheReadTokens`, `cacheWriteTokens` y `reasoningTokens` siguen una regla parecida pero con un tercer estado: la clave se **omite** cuando ningún evento contado la reporta, es la **suma** cuando todos los eventos contados la reportan, y es `null` cuando solo algunos lo hacen. El campo obsoleto `cachedTokens` se lee como `cacheReadTokens` cuando el campo nuevo está ausente.
- `costSource` se omite cuando ningún evento contado envía jamás la clave. En cuanto algún evento lo hace, un valor ausente o no reconocido en cualquier evento cuenta como `'unknown'` (el mismo valor por defecto que aplica el contrato canónico), y la cifra es el valor común cuando todos los eventos coinciden, `null` cuando no coinciden; así, una mezcla de un `'estimated'` explícito y un evento que no dijo nada da `null`.
- `failedCalls` cuenta los eventos `llm.failed`, de forma independiente a `llm.usage`: un agente con solo llamadas fallidas y ninguna exitosa igual recibe una entrada en `byAgent`, con el resto de las cifras en `null`. La clave se omite cuando no hay llamadas fallidas que reportar.
- Un costo está reportado solo si es un número finito y no negativo, y una moneda cuenta solo si es un código ISO 4217 (`^[A-Z]{3}$`, como `USD`). Valores como `'usd'`, `'dollars'` o `''` cuentan como sin moneda. Los costos nunca se convierten:

  | Costos vistos (tras deduplicar) | `cost` | `currency` |
  |---|---|---|
  | Ningún evento `llm.usage` | `null` | `undefined` |
  | Algún evento sin costo reportado | `null` | `undefined` |
  | Todos los costos en una sola moneda ISO, p. ej. todos en `USD` | suma | `'USD'` |
  | Dos o más monedas ISO, p. ej. `USD` y `COP` | `null` | `undefined` |
  | Al menos una moneda ISO y al menos un costo sin moneda | `null` | `undefined` |
  | Todos los costos reportados, ninguno con moneda | suma | `undefined` (se muestra como número simple) |

- `currency` se fija solo cuando `cost` se conoce, así que nunca aparece una moneda junto a un costo desconocido. Nunca se muestra una suma parcial.
- Las mismas reglas valen para cada agente en `byAgent`, con solo los eventos de ese agente: si a un agente le falta una cifra, solo ese agente y el total de la ejecución quedan como desconocidos.
- Sin ningún evento `llm.usage`, todas las cifras son `null` (se muestran como "desconocido"), no cero, y `byAgent` es `{}` (salvo que algún agente tenga eventos `llm.failed` propios, en cuyo caso recibe una entrada con `failedCalls` fijado y todo lo demás en `null`).

**Campos de correlación de uso (issue #64).** Los payloads de `llm.usage` y `llm.failed` pueden traer `traceId`, `parentId`, `toolCallId`, `meetingId`, `userId` y `tags` (ver [integration.md](integration.md#correlation-and-attribution-fields-issue-64), en inglés, para las reglas de validación). `summarizeUsage` no los lee: su resultado es idéntico tenga o no un evento estos campos, y nunca agrupa por ellos. Ningún componente de la librería muestra `userId` ni `tags`, ya que `userId` es una atribución seudónima y `tags` puede usarse para etiquetas internas, ninguno pensado para la vista embebida. La librería exporta los límites y el tipo correspondientes, solo como valores y tipo, sin ningún comportamiento nuevo: `CORRELATION_ID_MAX_LENGTH` (128), `USAGE_TAGS_MAX` (20), `USAGE_TAG_MAX_LENGTH` (64) y el tipo `UsageCorrelation`.

### Detalle de llamadas

Los totales por agente responden "quién gastó qué"; `showCallDetails` responde la siguiente pregunta: qué llamadas formaron ese número. `false` por defecto, independiente de `showUsage` y `showUsageBadges`:

```tsx
import type { AgentCallDetails } from '@warlockcode/agent-viewer';

const agentCallDetails = useMemo<AgentCallDetails>(() => ({
  builder: [
    {
      id: 'call-8f2',
      provider: 'Anthropic',
      model: 'claude-sonnet-4-5',
      tokens: { input: 1800, output: 450, cacheRead: 12000, cacheWrite: null },
      requestId: 'req_01H8',
      latencyMs: 2140,
      status: 'ok',
      costSource: 'provider-reported',
      cost: 0.012,
      currency: 'USD',
    },
  ],
}), []);

<AgentOffice events={events} locale="es" showCallDetails agentCallDetails={agentCallDetails} onSelectAgent={setSelected} />
```

- Al hacer clic en un agente del canvas, elegirlo de la lista de agentes por teclado, o fijar `selectedAgentId`, se abre un panel junto a las llamadas de ese agente, tal como vienen en `agentCallDetails[agentId]`. Un id seleccionado que no sea un agente del snapshot actual no abre nada. `onSelectAgent` no cambia: no existe un segundo callback para el panel.
- El panel nunca calcula, suma, cotiza ni ordena nada. Cada llamada aparece en el orden en que la enviaste, con 12 filas fijas: proveedor, modelo, estado, latencia, id de solicitud, tokens de entrada, tokens de salida, origen del costo y costo siempre; tokens de lectura de caché, escritura de caché y razonamiento solo cuando esa clave está presente en `tokens` (una clave enviada como `null` igual muestra "desconocido"; un `0` real muestra `0`; una clave omitida no muestra ninguna fila, la misma regla que usa `showUsage` para los campos de tokens opcionales).
- Un agente sin entrada en `agentCallDetails`, o con un arreglo vacío, muestra "No se proporcionó detalle de llamadas", nunca "0 llamadas".
- `AgentCallDetail` no tiene ningún campo que pueda llevar un prompt, una respuesta ni ningún otro texto libre: `provider`, `model` y `requestId` son las únicas cadenas libres, limitadas a 128 puntos de código Unicode (los valores más largos se cortan con puntos suspensivos, en el texto y en el atributo `title`), y `status`/`costSource` están cerrados a sus valores conocidos; cualquier otro valor se lee como "desconocido". El panel nunca difunde (`spread`) el objeto de la fila, así que una clave adicional que tu código agregue por error (`prompt`, `content`...) nunca se muestra.
- Cierra el panel con el botón de cerrar o con `Escape` (con el foco dentro de él); ambos llaman a `onSelectAgent(null)`, igual que pulsar de nuevo al agente seleccionado en la lista por teclado.
- El panel nunca se dibuja al [exportar video](#exportar-video): `recordReplay` no tiene ninguna opción para él.

### Cifras del servidor de Agent Viewer

Si tu app está conectada al servidor de Agent Viewer, lee `GET /api/v1/usage` (`usageSummary()` en el SDK de TypeScript) y pasa sus cifras tal cual. La librería sigue sin hacer cuentas: el host traduce cada grupo, y solo las cifras conocidas por completo se vuelven números.

```tsx
import type { UsageFigures } from '@warlockcode/agent-viewer';
import type { UsageBucket } from './sdk/typescript/index';

/** Solo cifras exactas: una suma parcial se vería como exacta, así que pasa a null ("desconocido"). */
function toFigures(bucket: UsageBucket): UsageFigures {
  const input = bucket.tokens.input.unreportedCount === 0 ? bucket.tokens.input.sum : null;
  const output = bucket.tokens.output.unreportedCount === 0 ? bucket.tokens.output.sum : null;
  const single = bucket.calls > 0 && bucket.costUnknownCount === 0 && bucket.byCurrency.length === 1
    ? bucket.byCurrency[0]
    : null;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input !== null && output !== null ? input + output : null,
    cost: single ? single.amount : null,
    currency: single ? single.currency : undefined,
  };
}

const summary = await viewer.usageSummary();
const usage = {
  total: toFigures(summary.total),
  byAgent: Object.fromEntries(
    summary.byAgent
      .filter((agent) => agent.agentId !== null)
      .map((agent) => [agent.agentId, toFigures(agent)]),
  ),
};
```

- `inputTokens` y `outputTokens` salen de `tokens.input.sum` y `tokens.output.sum` solo cuando el `unreportedCount` de ese tipo es `0`; si no, pasa `null`.
- `totalTokens` es la suma que hace el host de esos dos, y solo se envía cuando ambos cumplen esa condición; si no, `null`.
- `cost` y `currency` se envían solo cuando el grupo tiene llamadas, `costUnknownCount` es `0` y `byCurrency` tiene una sola entrada (una moneda, un origen de costo). Si no, envía `cost: null`, que se muestra como "desconocido".
- El grupo `agentId: null` (llamadas sin agente) no tiene clave en `byAgent`; solo cuenta en `total`. Las llamadas fallidas (`failed`) no forman parte de estas cifras.

### Alimentar `usage` desde el servidor (issue #66)

`GET /api/v1/usage/rollup` ([referencia completa](integration.md#usage-rollup-get-apiv1usagerollup-issue-66), en inglés) responde una pregunta más precisa que `GET /api/v1/usage`: un rango de tiempo, una base de tiempo y hasta 3 dimensiones de agrupación. El `toUsageFigures()` del SDK de TypeScript hace la misma traducción de "solo una cifra exacta se vuelve número" que `toFigures()` arriba, ya escrita para un grupo del rollup:

```tsx
import type { UsageFigures } from '@warlockcode/agent-viewer';
import { toUsageFigures } from './sdk/typescript/index';

const rollup = await viewer.usageRollup({
  groupBy: ['agent'],
  from: '2026-10-05T00:00:00Z',
  to: '2026-10-12T00:00:00Z',
});

const usage = {
  total: toUsageFigures(rollup.totals, { costSource: 'provider-reported' }),
  byAgent: Object.fromEntries(
    rollup.groups
      .filter((group) => group.key.agent !== null)
      .map((group) => [group.key.agent as string, toUsageFigures(group, { costSource: 'provider-reported' })]),
  ),
};

<AgentOffice events={events} showUsage usage={usage} />
```

`toUsageFigures(group, { costSource })` devuelve `cost` como número solo cuando el grupo tiene exactamente una entrada de costo, esa entrada tiene el origen (`costSource`) que pediste y `unknownCostCalls` es `0`; dos monedas, una mezcla de reportado/estimado o cualquier costo desconocido dan `cost: null`. `inputTokens`/`outputTokens` son `null` salvo que toda llamada del grupo haya reportado ese tipo, y `totalTokens` es su suma (sin tokens de cache ni de razonamiento) solo cuando ambos se conocen. Este helper corre en tu backend anfitrión, junto a la llamada del SDK: el componente sigue mostrando solo el `UsageFigures` que le pasas, importado aquí solo como tipo, nunca calculado por `@warlockcode/agent-viewer`.

El gasto por reunión y por herramienta (issue #80, `groupBy: ['meeting']`/`['tool']` en el mismo endpoint) funciona igual: `toUsageFigures()` mapea uno de esos grupos como cualquier otro, y si un anfitrión quiere mostrar el costo de una reunión o de una herramienta en la oficina, lo calcula del lado del servidor y lo pasa por sus propias props, igual que el ejemplo por agente de arriba. La librería no tiene ningún concepto de `meeting`/`tool`: nunca llama al rollup, nunca suma nada, y este cambio no agrega ningún import ni prop nuevo a `@warlockcode/agent-viewer`.

## Repetición

`useEventReplay` reproduce una ejecución grabada a su propio ritmo y devuelve el tramo visible, listo para `<AgentOffice events>`. Solo revela eventos; nunca crea ninguno. `ReplayControls` es una barra opcional para el hook: reproducir y pausar, volver al inicio, una barra de posición y botones de velocidad.

```tsx
import { AgentOffice, ReplayControls, useEventReplay, type OfficeEventInput } from '@warlockcode/agent-viewer';

export function RepeticionDeEjecucion({ run }: { run: readonly OfficeEventInput[] }) {
  const replay = useEventReplay(run, { speed: 2, maxGapMs: 3000 });

  return (
    <div style={{ display: 'grid', gridTemplateRows: '1fr auto', gap: 8, height: 600 }}>
      <AgentOffice events={replay.events} locale="es" />
      <ReplayControls replay={replay} locale="es" speeds={[1, 2, 4, 8]} />
    </div>
  );
}
```

Mantén `run` estable (estado, una prop o `useMemo`): un arreglo nuevo reinicia la repetición desde el principio. Los eventos se ordenan por `timestamp`, y cada uno espera el tiempo que esperó en la ejecución original, dividido por la velocidad.

Opciones de `useEventReplay(source, options)`:

| Opción | Valor por defecto | Descripción |
|---|---|---|
| `speed` | `1` | Multiplicador de velocidad. |
| `autoPlay` | `false` | Empieza a reproducir en cuanto hay eventos. |
| `maxGapMs` | `5000` | Espera máxima entre dos eventos, en tiempo de los eventos. Los silencios más largos se acortan. |
| `minGapMs` | `50` | Espera mínima entre dos eventos, para que las ráfagas se puedan leer. |

Devuelve un `EventReplay`:

| Campo | Descripción |
|---|---|
| `events` | Eventos visibles en la posición actual. |
| `position`, `total` | Cantidad de eventos visibles y de eventos en total. |
| `progress` | De 0 a 1. |
| `playing`, `speed` | Estado actual. |
| `play()`, `pause()`, `toggle()` | Reproducción. `play()` al final vuelve a empezar desde el principio. |
| `reset()` | Pausa y vuelve al inicio. |
| `seek(ratio)` | Salta a una posición entre 0 y 1. |
| `setSpeed(value)` | Cambia la velocidad (solo números positivos). |

Props de `ReplayControls`: `replay` (obligatoria), `speeds` (por defecto `[1, 2, 4]`), `locale`, `messages`, `t`, `theme` y `className`. También puedes construir tus propios controles con los campos de `EventReplay`.

Saltar hacia atrás reconstruye la oficina desde el inicio de la ejecución hasta la nueva posición. Gracias a los tiempos relativos de cada lote, después de un salto solo se ven las burbujas y los desplazamientos recientes.

## Cargar un archivo de log

`parseEventLog(input)` lee un log JSONL V1 canónico, o un archivo OTLP/JSON (un `string`, `File` o `Blob`, de hasta `MAX_EVENT_LOG_SIZE_BYTES`, 25 MB) y valida cada línea. El formato está en [event-log.md](event-log.md), incluida la sección sobre archivos OTLP de logs, métricas y trazas.

```tsx
async function cargarEjecucion(file: File) {
  const result = await parseEventLog(file);
  if (result.issues.length > 0) console.warn(result.issues);
  return result.events; // ordenados por timestamp, listos para useEventReplay
}
```

El resultado es `{ events, issues, totalLines, format, otlp? }`. Las líneas inválidas se reportan en `issues` (`line`, `error`, `raw?`, `code?`, `path?`) sin detener la lectura. Los logs OTLP se convierten en eventos `llm.usage`/`llm.failed`; las métricas OTLP devuelven cero eventos y un aviso explicando que son contadores preagregados; las trazas OTLP aún no se admiten y también devuelven cero eventos más un aviso. `otlp` (presente cuando `format === "otlp"`) reporta qué señales se encontraron y los contadores por registro `logRecords`/`converted`/`skipped`/`rejected`. El componente no trae una zona para soltar archivos; conecta tu propio selector de archivos a `parseEventLog`.

## Exportar video

`recordReplay(options)` graba una repetición de una ejecución en un `Blob` de video, en el navegador, con `MediaRecorder` y `canvas.captureStream`. Dibuja en su propio canvas fuera de pantalla, así que la oficina de la página no se ve afectada.

```tsx
import { isRecordingSupported, recordReplay, type OfficeEventInput } from '@warlockcode/agent-viewer';

async function exportarEjecucion(run: readonly OfficeEventInput[], signal: AbortSignal) {
  if (!isRecordingSupported()) return;
  const blob = await recordReplay({
    events: run,
    speed: 4,
    title: 'Ejecución sintética de revisión',
    locale: 'es',
    onProgress: (progress) => console.log(`${Math.round(progress * 100)}%`),
    signal,
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = blob.type.includes('mp4') ? 'ejecucion.mp4' : 'ejecucion.webm';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
```

| Opción | Valor por defecto | Descripción |
|---|---|---|
| `events` | obligatoria | Eventos de la ejecución. Se ordenan por `timestamp`. |
| `agents` | ninguno | Perfiles de agentes, como en `<AgentOffice>`. |
| `mode` | `'professional'` | Modo de la oficina. |
| `speed` | `1` | Multiplicador de velocidad. |
| `fps` | `30` | Cuadros por segundo. |
| `width`, `height` | `1280`, `720` | Tamaño del video en píxeles. |
| `maxGapMs` | `5000` | Espera máxima entre dos eventos. |
| `tailMs` | `2000` | Tiempo que se mantiene el último cuadro después del evento final. |
| `maxDurationMs` | `600000` | Límite de duración del video (10 minutos). |
| `theme` | `'dark'` | Paleta. |
| `locale`, `messages`, `t` | ninguno (inglés) | Textos, como en `<AgentOffice>`. |
| `title` | ninguno | Se dibuja en la esquina. Si falta, no se dibuja nada. |
| `showUsage`, `usage` | `false` | Dibuja las cifras de `usage.total` que pases. La exportación nunca calcula consumo. |
| `onProgress` | ninguno | Se llama con un valor de 0 a 1. |
| `signal` | ninguno | `AbortSignal`. Al abortar, la promesa se rechaza con un `AbortError`. |

Notas:

- La grabación ocurre en tiempo real: un video de un minuto tarda más o menos un minuto en grabarse. Usa `speed` y `maxGapMs` para acortar ejecuciones largas, y `computeReplaySchedule(events, { speed, maxGapMs, tailMs, maxDurationMs })` para conocer la duración de antemano (`durationMs`).
- El formato es el primero que admita el navegador entre WebM (VP9, VP8) y MP4; `getSupportedMimeType()` te dice cuál.
- La promesa se rechaza si el navegador no puede grabar (`isRecordingSupported()` es `false`) o no admite ninguno de esos formatos.
- El video muestra la hora del último evento visible (`video.time`).
- `RecordReplayOptions` no tiene ningún campo para el detalle de llamadas: el panel de `showCallDetails`/`agentCallDetails` nunca se dibuja en un video, sin importar qué muestre la página desde la que se capturó.

## El modelo de la oficina sin árbol React

`OfficeStore` y `buildOfficeSnapshot` derivan la oficina de los eventos sin dibujar nada: en un servidor, en pruebas o para tus propias exportaciones.

```ts
import { buildOfficeSnapshot } from '@warlockcode/agent-viewer';

const snapshot = buildOfficeSnapshot(events, { agents, now: Date.now() });
for (const agent of snapshot.agents) {
  console.log(`${agent.name}: ${agent.status} en ${agent.workspace}`);
}
```

`buildOfficeSnapshot(events, options)` acepta `mode`, `bubbleMs`, `locale`, `agents` y `now`, y devuelve un `OfficeSnapshot`:

- `agents`: copias de los agentes visibles (`Agent`), con `status`, `statusText`, `workspace`, posición, `currentTool`, `speechBubble` y el resto de su estado. Una burbuja se ve mientras `speechBubble.expiresAt` sea posterior a la hora actual.
- `meetings`: reuniones con sus participantes, estado, mensajes y decisiones.
- `activeMeetingId`: la reunión en curso, o `null`.

Los campos de consumo de `Agent` (`tokensInput`, `tokensOutput`, `cost`...) se quedan en cero, porque el store nunca suma consumo.

Para trabajar de forma incremental, conserva un store:

```ts
import { OfficeStore } from '@warlockcode/agent-viewer';

const store = new OfficeStore({ mode: 'professional', bubbleMs: 6500, locale: 'es' });
store.sync(events, agents, Date.now()); // aplica los eventos nuevos, o reconstruye si la lista cambió
store.tick(Date.now());                 // termina desplazamientos e inicia reuniones cuyos participantes llegaron
const { agents: visibles, meetings, activeMeetingId } = store.snapshot();
```

`sync` y `tick` devuelven `true` cuando algo cambió. Cada store es independiente y guarda todo en memoria.

El punto de entrada del paquete también exporta los componentes React, así que `react` debe seguir instalado aunque solo uses el store.

## Utilidades del contrato de eventos

La oficina acepta `OfficeEventInput`: un `CanonicalEvent` completo, un `CanonicalEventInput` (solo `id`, `type` y `timestamp` son obligatorios, y `timestamp` puede ser un texto ISO 8601) o un `ViewerEvent` heredado.

- `validateCanonicalEvent(input)` valida un evento de forma estricta contra el contrato V1 y devuelve `{ success, data, issues }`.
- `normalizeCanonicalEvent(input)` completa un evento flexible sin validarlo.
- `SCHEMA_VERSION`, `CANONICAL_EVENT_TYPES`, `EVENT_TYPE_ALIASES`, `MESSAGE_KINDS` e `isMessageKind` describen el contrato.
- `LLM_ERROR_KINDS` enumera los valores de `errorKind` de `llm.failed` (`rate_limited`, `overloaded`, `timeout`, `invalid_request`, `auth`, `server_error`, `cancelled`, `unknown`), e `isLlmErrorKind(value)` comprueba uno. El tipo es `LlmErrorKind`.

Campos del contrato que usa la oficina en esta versión:

- `agent.message.sent` acepta un `kind` opcional, uno de `MESSAGE_KINDS`.
- `type` de `meeting.message` es uno de `MESSAGE_KINDS` (por defecto `statement`).
- `llm.usage` acepta un `currency` opcional, un código ISO 4217 de tres letras mayúsculas como `USD`.
- `llm.usage` reporta los tokens de caché en `cacheReadTokens` (leídos de la caché de prompts) y `cacheWriteTokens` (escritos en ella). Los dos forman parte de `inputTokens`. `cachedTokens` queda obsoleto: se sigue aceptando y se copia en `cacheReadTokens`.
- Un contador que no se reportó (`cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`, `cachedTokens`) queda ausente o en `null` después de validar, nunca en `0`. `normalizeCanonicalEvent` tampoco inventa `inputTokens` ni `outputTokens`.
- `llm.failed` reporta un intento fallido de llamada al modelo con `provider`, `model` y `errorKind`. La oficina solo guarda el proveedor y el modelo.

El contrato completo está en [integration.md](integration.md) y en [`canonicalContract.ts`](../src/integrations/canonicalContract.ts).

## Referencia de la API

Todo se exporta desde `@warlockcode/agent-viewer`. La hoja de estilos es `@warlockcode/agent-viewer/style.css`.

| Área | Valores | Tipos |
|---|---|---|
| Oficina | `AgentOffice` | `AgentOfficeProps` |
| Modelo de la oficina | `OfficeStore`, `buildOfficeSnapshot` | `AgentProfile`, `OfficeEventInput`, `OfficeMode`, `OfficeSnapshot`, `OfficeStoreOptions` |
| Repetición | `useEventReplay`, `ReplayControls` | `EventReplay`, `EventReplayOptions`, `ReplayControlsProps` |
| Consumo | `formatUsage`, `formatTokens`, `formatCost`, `formatCostSource`, `formatUsageBadge`, `summarizeUsage` | `OfficeUsage`, `UsageFigures`, `FormattedUsageItem`, `UsageBadge`, `UsageCostSource` |
| Detalle de llamadas | ninguno | `AgentCallDetail`, `AgentCallDetails`, `AgentCallTokens`, `AgentCallStatus`, `AgentCallCostSource` |
| Textos | `OFFICE_MESSAGES`, `createOfficeTranslator`, `formatMessage`, `builtInMessages`, `isOfficeMessageKey` | `OfficeMessageKey`, `OfficeMessages`, `OfficeMessageParams`, `OfficeTranslate`, `OfficeTranslatorOptions`, `HostTranslate` |
| Tipos base | ninguno | `Agent`, `AgentRole`, `AgentStatus`, `AgentMood`, `WorkspaceZone`, `ViewerEvent`, `Task`, `TaskStatus`, `Meeting`, `MeetingMessage` |
| Contrato de eventos V1 | `SCHEMA_VERSION`, `CANONICAL_EVENT_TYPES`, `EVENT_TYPE_ALIASES`, `MESSAGE_KINDS`, `isMessageKind`, `LLM_ERROR_KINDS`, `isLlmErrorKind`, `normalizeCanonicalEvent`, `validateCanonicalEvent` | `CanonicalEvent`, `CanonicalEventInput`, `CanonicalEventType`, `LegacyEventType`, `EventSeverity`, `MessageKind`, `LlmErrorKind`, `ValidationIssue`, `ValidationResult` |
| Stream en vivo | `connectEventStream` | `RealtimeConnection`, `RealtimeStatus`, `RealtimeConnectionOptions`, `RealtimeResync`, `RealtimeReplayed` |
| Archivos de log | `parseEventLog`, `MAX_EVENT_LOG_SIZE_BYTES` | `EventLogParseResult`, `EventLogParseIssue`, `EventLogIssueCode`, `EventLogOtlpSummary` |
| Video | `recordReplay`, `computeReplaySchedule`, `isRecordingSupported`, `getSupportedMimeType` | `RecordReplayOptions`, `ReplaySchedule` |

`connectEventStream(baseUrl, onEvent, onStatus?, options?)` abre el flujo en `${baseUrl}/api/v1/events/stream`, llama a `onEvent` con cada evento válido y se reconecta con espera progresiva, retomando desde el último id de evento. El token nunca viaja en una URL, en ningún transporte (issue #71). Opciones: `token` (viaja en una cabecera `Authorization: Bearer` sobre un `fetch` con streaming, cuando el navegador puede leer el cuerpo de un `fetch` en streaming; cuando no puede, el cliente llama antes a `POST /api/v1/stream-tickets` con el token, antes de cada conexión y reconexión, y abre `EventSource` con el ticket de un solo uso que recibe; con token y sin ningún `fetch`, la conexión se detiene con estado `error` y no hace ninguna llamada de red), `fetch` (el `fetch` que usa ese flujo y para emitir tickets, por defecto el global), `maxReconnectAttempts` (por defecto sin límite), `initialBackoffMs` (1000), `maxBackoffMs` (15000), `heartbeatTimeoutMs` (35000), `lastEventId` (inicia el flujo desde este cursor, normalmente `snapshot.lastEventId`) y `onResync` / `onReplayed` (abajo). `onStatus` recibe `connecting`, `connected`, `reconnecting`, `disconnected`, `error`, `closed` o `resyncing`. La conexión devuelta tiene `close()`, `status()`, `getLastEventId()` y `resyncCount()`.

### Reenvío al reconectar y resincronización (issue #54)

Al reconectar, el servidor reenvía cada evento perdido, en orden y exactamente una vez, o lo avisa con un cuadro `resync`; nunca envía un reenvío parcial. El formato y la regla del servidor están en [integration.md](integration.md#reconnect-replay-and-resync). La ayuda expone los dos resultados en vez de ocultarlos:

- `onResync?: (info: RealtimeResync) => string | null | undefined | Promise<...>` se llama cuando el servidor no pudo reenviar todo lo perdido. `info.reason` es `cursor_unknown`, `gap_too_large` o `buffer_overflow`; `info.missed` es la cantidad de eventos que el cliente nunca vio, o `null` cuando el servidor mismo no lo sabe (un cursor desconocido: nunca trates `null` como `0`). Recarga tu estado (normalmente `GET /api/v1/snapshot`) y devuelve el cursor desde el que retomar, usualmente `snapshot.lastEventId`; devolver `null` o `undefined` retoma solo en vivo. Si lanza o rechaza, se reconecta con la espera progresiva existente y vuelve a llamar a `onResync` en la siguiente resincronización, sin tocar el cursor. Resincronizaciones consecutivas sin nada recibido entre ellas también esperan el retraso de espera progresiva, así un servidor atascado resincronizando no puede causar un bucle de reconexión apretado.
- `onReplayed?: (info: RealtimeReplayed) => void` se llama cuando termina un reenvío de reconexión, incluso uno que reenvió `0` eventos. `info.replayed` es la cantidad de cuadros y `info.lastEventId` el id del último (`null` cuando `replayed` es `0`).
- Sin `onResync`, una resincronización igual reporta el estado `resyncing` e incrementa `resyncCount()`, y luego se reconecta solo en vivo: el anfitrión se entera del hueco aunque no recargue un snapshot.

Patrón recomendado: carga el snapshot una vez, inicia el flujo desde su cursor, y recarga de la misma forma al resincronizar. `snapshot.events` solo trae los 100 eventos más recientes (reconstruye la oficina, nunca los totales), y las cifras de consumo deben venir de los agregados propios del snapshot (`totalTokens`, `totalCost`), nunca de volver a sumar esos 100 eventos:

```ts
const load = async () => {
  const snapshot = await fetch(`${base}/api/v1/snapshot`).then((r) => r.json());
  setEvents(snapshot.events.slice().reverse());
  setServerTotals({ tokens: snapshot.totalTokens, cost: snapshot.totalCost });
  return snapshot.lastEventId ?? undefined;
};
const lastEventId = await load();
const connection = connectEventStream(base, (event) => setEvents((prev) => [...prev, event]), setStatus, {
  lastEventId,
  onResync: async () => (await load()) ?? null,
});
```

`snapshot.totalCost` y `agents[].cost` por ahora cuentan un costo faltante como `0` en el servidor (seguido aparte); no los muestres a un usuario como una cifra segura.

## Garantías de aislamiento

- Dos oficinas en la misma página nunca comparten estado: cada `<AgentOffice>` tiene su propio store.
- No se lee ni se escribe nada en `localStorage` ni en ningún otro almacenamiento del navegador.
- Ningún temporizador inventa datos. La oficina revisa cada 250 ms si terminaron los desplazamientos y si pueden empezar las reuniones; solo `mode="showcase"` agrega actividad simulada, y va marcada como simulada.
- No hay atajos de teclado globales.
- Nada se ejecuta al importar y no se inyectan estilos.
- En frameworks con componentes de servidor, renderiza `<AgentOffice>` desde un componente de cliente (por ejemplo con `'use client'` en Next.js), porque usa hooks y un canvas.

La app de demostración de este repositorio (`npm run dev`) se construye aparte con `npm run build`. La librería se construye con `npm run build:lib` en `dist-lib/`.

## Versiones

La librería sigue [Versionado Semántico](https://semver.org/lang/es/). Mientras esté en 0.x, la API todavía puede cambiar: una versión menor (0.3.0, 0.4.0...) puede traer cambios incompatibles, y se listan en el [CHANGELOG](../CHANGELOG.md). Un rango como `^0.2.0` solo acepta parches 0.2.x.
