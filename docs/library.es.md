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

Las dependencias de ejecución son `lucide-react` (iconos) y `zod` (validación estricta de eventos). Incluye las declaraciones de TypeScript.

La publicación en npm llegará pronto. Mientras tanto, instala el paquete desde el archivo de la release de GitHub:

```bash
npm install https://github.com/jmmana/Agent-Viewer/releases/download/v0.2.0/warlockcode-agent-viewer-0.2.0.tgz
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
| `usage` | `OfficeUsage` | ninguno | Cifras de consumo calculadas por tu app. La oficina nunca las calcula. |
| `selectedAgentId` | `string \| null` | ninguno | Selección controlada. Déjala sin definir para que la oficina lleve la suya. Cuando cambia, la cámara se centra en ese agente. |
| `onSelectAgent` | `(agentId: string \| null) => void` | ninguno | Se llama cuando quien mira hace clic en un agente del canvas. |
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

Hay 116 claves. Las claves `screen.tokenFlow`, `screen.telemetry`, `screen.open`, `canvas.modelOps`, `canvas.showTimeline`, `canvas.hideTimeline` y `modelOps.*` pertenecen a la consola Model Ops y a la línea de tiempo de la app de demostración; la oficina embebida no las muestra.

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

#### `usage.*` (6)

| Clave | Texto en español | Texto en inglés |
|---|---|---|
| `usage.title` | Consumo | Usage |
| `usage.tokens` | Tokens | Tokens |
| `usage.inputTokens` | Tokens de entrada | Input tokens |
| `usage.outputTokens` | Tokens de salida | Output tokens |
| `usage.cost` | Costo | Cost |
| `usage.unknown` | desconocido | unknown |

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
| `--av-accent-contrast` | `#ffffff` | `#ffffff` | Texto e iconos sobre `--av-accent-strong`. |
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
<AgentOffice className="oficina-equipo" events={events} />
<ReplayControls className="repeticion-equipo" replay={replay} />
```

Notas:

- El dibujo del canvas (piso, muebles, agentes, tarjetas de nombre y burbujas) usa la paleta oscura o clara que elige `theme`. Las variables `--av-*` no lo cambian.
- No se carga ninguna fuente. El texto del canvas pide `"Plus Jakarta Sans"` y usa la fuente sans-serif del navegador si tu página no la ofrece.
- Clases a las que puedes apuntar: `av-office`, `av-theme-dark`, `av-theme-light`, `av-office-stage`, `av-office-empty`, `av-usage`, `av-usage-item`, `av-sr-only`, `av-canvas-root`, `av-toolbar`, `av-toolbar-sep`, `av-tool-btn`, `av-tool-btn--accent`, `av-tool-btn--active`, `av-zoom-level`, `av-stage`, `av-canvas`, `av-icon`, `av-replay`, `av-replay-btn`, `av-replay-btn--primary`, `av-replay-range`, `av-replay-progress`, `av-replay-speed`. Las clases `av-tooltip*`, `av-tool-btn--telemetry` y `av-icon--live` las usa la app de demostración.

## Accesibilidad

- La oficina es un `<section>` con el nombre de `ariaLabel` (por defecto, el texto de `office.label`).
- El canvas tiene `role="img"` y un `aria-label` (`canvas.aria`) que remite a la lista en texto.
- Una lista oculta a la vista y anunciada con cortesía (`aria-live="polite"`) nombra a cada agente con su rol y su estado, por ejemplo "Atlas, Desarrollador: Programando". Con `showUsage`, cada línea incluye además las cifras de ese agente en `usage.byAgent`.
- La barra (`role="toolbar"`) y los controles de repetición son botones reales con nombre accesible y anillo de foco visible. La barra de posición anuncia el avance y los botones de velocidad usan `aria-pressed`.
- Con `prefers-reduced-motion: reduce` nada se anima: los agentes llegan a su destino sin caminar, los detalles animados se quedan quietos y las transiciones de los botones se desactivan.
- La oficina no registra atajos de teclado. Seleccionar un agente en el canvas requiere puntero; si tus usuarios necesitan seleccionar con el teclado, muestra tu propia lista y pasa `selectedAgentId`.

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

`OfficeUsage` es `{ total?: UsageFigures; byAgent?: Record<string, UsageFigures> }`, y `UsageFigures` tiene `totalTokens`, `inputTokens`, `outputTokens`, `cost` y `currency` (todos opcionales).

Reglas de presentación:

- `showUsage` es `false` por defecto. Sin él, `usage` se ignora.
- `total` aparece en un panel pequeño en la esquina superior derecha: tokens y costo siempre; tokens de entrada y de salida solo si envías esos campos.
- Las cifras de `byAgent`, indexadas por id de agente, aparecen en la lista accesible de agentes.
- Un valor que falta (`undefined`, `null` o un número no finito) se muestra como "desconocido" (`usage.unknown`), nunca como cero. `totalTokens` no se deriva de los tokens de entrada y de salida: envíalo tú.
- `cost` se muestra como moneda cuando `currency` es un código ISO 4217 como `USD` o `COP`, y como número simple en otro caso. Los números siguen a `locale`.

`formatUsage(figures, locale, translate)`, `formatTokens` y `formatCost` devuelven los mismos valores formateados, por si quieres mostrarlos en otra parte de tu interfaz.

Si tu app no tiene un servicio de consumo, `summarizeUsage(events)` es una ayuda opcional y explícita. Solo suma las cifras que reportan los eventos `llm.usage` y nunca pone precio a los tokens:

```tsx
const usage = useMemo(() => summarizeUsage(events), [events]);
```

- `totalTokens` es `inputTokens + outputTokens`. Los tokens que un evento no reporta cuentan como cero.
- El `cost` es `null` (se muestra como "desconocido") si algún evento `llm.usage` no reporta costo, o si los eventos reportan monedas distintas. Nunca se muestra una suma parcial.
- Las mismas reglas valen para cada agente en `byAgent`, con solo los eventos de ese agente.
- Sin ningún evento `llm.usage`, todas las cifras son `null` (se muestran como "desconocido"), no cero.

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

`parseEventLog(input)` lee un log JSONL V1 canónico (un `string`, `File` o `Blob`, de hasta `MAX_EVENT_LOG_SIZE_BYTES`, 25 MB) y valida cada línea. El formato está en [event-log.md](event-log.md).

```tsx
async function cargarEjecucion(file: File) {
  const result = await parseEventLog(file);
  if (result.issues.length > 0) console.warn(result.issues);
  return result.events; // ordenados por timestamp, listos para useEventReplay
}
```

El resultado es `{ events, issues, totalLines, format }`. Las líneas inválidas se reportan en `issues` (`line`, `error`, `raw`) sin detener la lectura. Las trazas OTLP no se admiten: devuelven cero eventos y un aviso que dice que las trazas OTLP aún no se admiten. El componente no trae una zona para soltar archivos; conecta tu propio selector de archivos a `parseEventLog`.

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

Campos del contrato que usa la oficina en esta versión:

- `agent.message.sent` acepta un `kind` opcional, uno de `MESSAGE_KINDS`.
- `type` de `meeting.message` es uno de `MESSAGE_KINDS` (por defecto `statement`).
- `llm.usage` acepta un `currency` opcional, un código ISO 4217 de tres letras mayúsculas como `USD`.

El contrato completo está en [integration.md](integration.md) y en [`canonicalContract.ts`](../src/integrations/canonicalContract.ts).

## Referencia de la API

Todo se exporta desde `@warlockcode/agent-viewer`. La hoja de estilos es `@warlockcode/agent-viewer/style.css`.

| Área | Valores | Tipos |
|---|---|---|
| Oficina | `AgentOffice` | `AgentOfficeProps` |
| Modelo de la oficina | `OfficeStore`, `buildOfficeSnapshot` | `AgentProfile`, `OfficeEventInput`, `OfficeMode`, `OfficeSnapshot`, `OfficeStoreOptions` |
| Repetición | `useEventReplay`, `ReplayControls` | `EventReplay`, `EventReplayOptions`, `ReplayControlsProps` |
| Consumo | `formatUsage`, `formatTokens`, `formatCost`, `summarizeUsage` | `OfficeUsage`, `UsageFigures`, `FormattedUsageItem` |
| Textos | `OFFICE_MESSAGES`, `createOfficeTranslator`, `formatMessage`, `builtInMessages`, `isOfficeMessageKey` | `OfficeMessageKey`, `OfficeMessages`, `OfficeMessageParams`, `OfficeTranslate`, `OfficeTranslatorOptions`, `HostTranslate` |
| Tipos base | ninguno | `Agent`, `AgentRole`, `AgentStatus`, `AgentMood`, `WorkspaceZone`, `ViewerEvent`, `Task`, `TaskStatus`, `Meeting`, `MeetingMessage` |
| Contrato de eventos V1 | `SCHEMA_VERSION`, `CANONICAL_EVENT_TYPES`, `EVENT_TYPE_ALIASES`, `MESSAGE_KINDS`, `isMessageKind`, `normalizeCanonicalEvent`, `validateCanonicalEvent` | `CanonicalEvent`, `CanonicalEventInput`, `CanonicalEventType`, `LegacyEventType`, `EventSeverity`, `MessageKind`, `ValidationIssue`, `ValidationResult` |
| Stream en vivo | `connectEventStream` | `RealtimeConnection`, `RealtimeStatus`, `RealtimeConnectionOptions` |
| Archivos de log | `parseEventLog`, `MAX_EVENT_LOG_SIZE_BYTES` | `EventLogParseResult`, `EventLogParseIssue` |
| Video | `recordReplay`, `computeReplaySchedule`, `isRecordingSupported`, `getSupportedMimeType` | `RecordReplayOptions`, `ReplaySchedule` |

`connectEventStream(baseUrl, onEvent, onStatus?, options?)` abre un `EventSource` en `${baseUrl}/api/v1/events/stream`, llama a `onEvent` con cada evento válido y se reconecta con espera progresiva, retomando desde el último id de evento. Opciones: `token` (se envía como parámetro `token` de la URL), `maxReconnectAttempts` (por defecto sin límite), `initialBackoffMs` (1000), `maxBackoffMs` (15000) y `heartbeatTimeoutMs` (35000). `onStatus` recibe `connecting`, `connected`, `reconnecting`, `disconnected`, `error` o `closed`. La conexión devuelta tiene `close()`, `status()` y `getLastEventId()`.

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
