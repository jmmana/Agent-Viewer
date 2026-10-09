# Agent Viewer library guide

`@warlockcode/agent-viewer` puts the Agent Viewer office inside your own React app. The office is a Canvas2D scene drawn only from the events you pass: the agents your runtime registers, their statuses, the tools they use, the messages they send and the meetings they hold.

This guide covers version **0.2.0**. Leer en español: [library.es.md](library.es.md).

## Contents

- [Install](#install)
- [Import the styles](#import-the-styles)
- [Minimal example](#minimal-example)
- [Live events](#live-events)
- [`<AgentOffice>` props](#agentoffice-props)
- [Modes](#modes)
- [How events change the office](#how-events-change-the-office)
- [Message kinds and speech bubbles](#message-kinds-and-speech-bubbles)
- [Workspaces](#workspaces)
- [Translations](#translations)
- [Theming](#theming)
- [Accessibility](#accessibility)
- [Usage figures](#usage-figures)
- [Replay](#replay)
- [Loading a log file](#loading-a-log-file)
- [Video export](#video-export)
- [The office model without a React tree](#the-office-model-without-a-react-tree)
- [Event contract helpers](#event-contract-helpers)
- [API reference](#api-reference)
- [Isolation guarantees](#isolation-guarantees)
- [Versioning](#versioning)

## Install

Requirements:

- React and React DOM 19 (`^19.0.0`). They are peer dependencies, so your app provides them.
- A bundler or framework that understands ES modules and CSS imports (Vite, Next.js, webpack and similar). The package is ESM only: there is no CommonJS build.

The runtime dependencies are `lucide-react` (icons) and `zod` (strict event validation). TypeScript declarations are included.

Publication on npm is coming soon. Until then, install the package from the GitHub release asset:

```bash
npm install https://github.com/jmmana/Agent-Viewer/releases/download/v0.2.1/warlockcode-agent-viewer-0.2.1.tgz
```

The package name is `@warlockcode/agent-viewer` in both cases, so your imports will not change when you switch to the npm registry.

## Import the styles

The library does not inject any CSS. Import the stylesheet once, for example in your app entry:

```ts
import '@warlockcode/agent-viewer/style.css';
```

The stylesheet has no reset or preflight and no global selectors. Every class starts with `av-`, the theme lives in `--av-*` custom properties that you can override, and no external fonts are loaded. See [Theming](#theming).

`<AgentOffice>` fills its container (`width: 100%; height: 100%`, at least 320 px tall), so give the container a height.

## Minimal example

The example below uses synthetic data. It registers two agents through profiles and sends two events.

```tsx
import { AgentOffice, type AgentProfile, type OfficeEventInput } from '@warlockcode/agent-viewer';
import '@warlockcode/agent-viewer/style.css';

// Defined outside the component, so the arrays keep the same identity on every render.
const agents: AgentProfile[] = [
  { id: 'planner', name: 'Nova', roleTitle: 'Planner', workspace: 'leads_area', avatarColor: '#38bdf8' },
  { id: 'builder', name: 'Atlas', roleTitle: 'Builder', workspace: 'development', avatarColor: '#f472b6' },
];

const events: OfficeEventInput[] = [
  {
    schemaVersion: '1.0',
    id: 'evt-001',
    type: 'agent.status.changed',
    timestamp: 1767225600000,
    source: 'agent:builder',
    agentId: 'builder',
    summary: 'Builder started coding',
    payload: { status: 'CODING', statusText: 'Writing the parser' },
  },
  {
    schemaVersion: '1.0',
    id: 'evt-002',
    type: 'agent.message.sent',
    timestamp: 1767225601000,
    source: 'agent:planner',
    agentId: 'planner',
    summary: 'Planner proposes an order',
    payload: { text: 'Ship the parser first, then the exporter.', kind: 'proposal', targetAgentId: 'builder' },
  },
];

export function TeamOffice() {
  return (
    <div style={{ height: 520 }}>
      <AgentOffice agents={agents} events={events} locale="en" theme="dark" />
    </div>
  );
}
```

Atlas appears at a desk in Engineering with the status "Coding". Nova appears in Architecture with a speech bubble headed `Nova → Atlas · PROPOSES` for 6.5 seconds.

## Live events

`<AgentOffice>` is controlled by the `events` prop. For live activity, append each new event to the array and pass the new array. The office applies only the new events; any other change to the list (a different run, a shorter slice) rebuilds the office from scratch.

```tsx
import { useEffect, useState } from 'react';
import { AgentOffice, connectEventStream, type OfficeEventInput } from '@warlockcode/agent-viewer';

export function LiveOffice() {
  const [events, setEvents] = useState<OfficeEventInput[]>([]);

  useEffect(() => {
    const connection = connectEventStream('http://localhost:8787', (event) => {
      setEvents((list) => [...list, event]);
    });
    return () => connection.close();
  }, []);

  return (
    <div style={{ height: 600 }}>
      <AgentOffice events={events} />
    </div>
  );
}
```

Events can come from anywhere: your own WebSocket, a polling loop, a store. `connectEventStream` is a helper for the Server-Sent Events stream of an Agent Viewer server (`GET /api/v1/events/stream`), described in [API reference](#api-reference).

Identity matters, because the component compares references:

- `events`: pass a new array when it changes (`[...list, event]`). Mutating the same array in place is not detected.
- `agents`: keep the same array between renders (a module constant, state or `useMemo`). A new array rebuilds the office.
- `messages` and `t`: memoize them. A new object or function on each render rebuilds the translator and restarts the canvas drawing loop.

Give every event a stable, unique `id`. The office ignores an event whose `id` it has already applied, and uses the ids to tell an appended list from a different one.

## `<AgentOffice>` props

| Prop | Type | Default | Description |
|---|---|---|---|
| `events` | `readonly OfficeEventInput[]` | `[]` | The source of truth. The office is derived only from these events. Append for live activity, pass a slice of a recorded run for replay. |
| `agents` | `readonly AgentProfile[]` | none | Agents known before their first event. Each profile is equivalent to an `agent.registered` event. |
| `mode` | `'professional' \| 'showcase'` | `'professional'` | See [Modes](#modes). |
| `locale` | `string` | `'en'` | BCP 47 locale such as `es-CO`. Picks the built-in texts (`es…` uses Spanish, anything else English) and the number format of usage figures. |
| `messages` | `Partial<OfficeMessages>` | none | Overrides for single texts. Memoize it. See [Translations](#translations). |
| `t` | `HostTranslate` | none | Your translate function. Wins over `messages` when it returns a value. Keep it stable. |
| `theme` | `'dark' \| 'light'` | `'dark'` | Palette of the canvas drawing and the `av-theme-dark` or `av-theme-light` class. |
| `showUsage` | `boolean` | `false` | Shows the figures passed in `usage`. See [Usage figures](#usage-figures). |
| `usage` | `OfficeUsage` | none | Usage figures computed by your app. The office never computes them. |
| `selectedAgentId` | `string \| null` | none | Controlled selection. Leave it undefined to let the office keep its own. When it changes, the camera centers on that agent. |
| `onSelectAgent` | `(agentId: string \| null) => void` | none | Called when the viewer clicks an agent on the canvas. |
| `bubbleDurationMs` | `number` | `6500` | How long a speech bubble stays on screen, in milliseconds. |
| `className` | `string` | none | Extra class for the root `<section class="av-office av-theme-…">`. |
| `style` | `React.CSSProperties` | none | Inline styles for the root element. |
| `ariaLabel` | `string` | `office.label` text | Accessible name of the office region. |

`AgentProfile`:

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Agent id, the same one your events use in `agentId`. Required. |
| `name` | `string` | Display name. Required. |
| `roleTitle` | `string` | Free text shown on the name card, for example `Planner`. |
| `team` | `'leadership' \| 'engineering' \| 'research' \| 'quality' \| 'operations' \| 'other'` | Team of the agent. |
| `workspace` | `WorkspaceZone` | Room where the agent sits. See [Workspaces](#workspaces). |
| `avatarColor` | `string` | Hex color, for example `#38bdf8`. Other values are ignored. |

Canvas controls: the toolbar on the left rotates the office, fits it to the view and zooms in and out. Viewers can also drag to pan and use the mouse wheel to zoom. Clicking an agent selects it.

## Modes

| Mode | What the office shows |
|---|---|
| `professional` (default) | Only what the events say. No ambient life, no invented lines, no hidden second floor and no sounds. When a meeting is requested, participants just walk to the room. |
| `showcase` | Adds simulated office life for demos. Agents that stay idle go for coffee and chat in short simulated conversations. Those bubbles are headed `SOCIAL · SIMULATED` and never change an agent's work status. Meeting requests never get invented lines, in either mode. |

The language of the simulated conversations follows `locale` (Spanish or English).

## How events change the office

Events follow the canonical contract V1 (see [integration.md](integration.md) and [`canonicalContract.ts`](../src/integrations/canonicalContract.ts)). The office reads `id`, `type`, `timestamp` (milliseconds), `source`, `agentId`, `taskId`, `summary` and `payload`. Missing envelope fields are filled in leniently; use `validateCanonicalEvent` if you want strict checks.

The agent of an event is `agentId`, then `payload.agentId`, then `payload.id` for `agent.*` events, then a `source` of the form `agent:<id>`.

| Event | Payload fields read | Effect in the office |
|---|---|---|
| `agent.registered` | `name`, `roleTitle`, `role`, `team`, `workspace`, `avatarColor` (hex), `status`, `statusText`, `provider`, `model`, `managerId` | Adds the agent, or updates it if it exists. A new agent appears directly at its workspace; an existing one walks there. A valid `status` sets the initial status. |
| `agent.updated` | `name`, `roleTitle`, `provider`, `model`, `statusText`, `workspace` | Updates the profile. With a valid `workspace`, the agent walks there and makes it its home. |
| `agent.status.changed` | `status`, `statusText`, `workspace` | Sets the status (case insensitive; unknown statuses are ignored). The agent moves only if a valid `workspace` is given. |
| `agent.message.sent` | `text`, `kind`, `targetAgentId`, `targetAgentName` | Shows a speech bubble. With a target, the header names it and a dashed line joins both agents. |
| `meeting.requested` | `participantIds`, `meetingId`, `title`, `topic` | Reserves the first free meeting room for the group. Participants change to `WALKING` and walk to their seats; the meeting starts when everyone has arrived, and they change to `IN_MEETING`. |
| `meeting.started` | `meetingId`, `participantIds`, `title` | Starts a requested meeting at once, without waiting for everyone to arrive. If `meetingId` is unknown and `participantIds` is given, the meeting is requested and started. |
| `meeting.message` | `text`, `type`, `meetingId`, `targetAgentId`, `targetAgentName` | Shows a speech bubble headed by the message kind and records the message in the meeting (the active one when `meetingId` is missing). A `decision` is also added to the meeting decisions. |
| `meeting.ended`, `meeting.cancelled` | `meetingId` | Ends the meeting and frees the room. Participants change to `IDLE` and walk back to their workspace. |
| `tool.started` | `tool`, `inputSummary` | Status `USING_TOOL`. |
| `tool.completed` | `tool`, `outputSummary` | Status `IDLE`. |
| `tool.failed` | `tool`, `error` | Status `ERROR`. |
| `task.created`, `task.assigned` | `id` or `taskId`, `title`, `assignedAgentId` | Recorded; no visible change. |
| `task.progress` | `taskId`, `progress` | The task becomes the agent's current task; no visible change. |
| `task.completed` | `taskId` | Status `DONE` if it was the agent's current task. |
| `task.failed` | `taskId`, `error` | Status `ERROR` if it was the agent's current task. |
| `task.blocked` | `taskId`, `reason` | Status `BLOCKED`. |
| `llm.usage` | `provider`, `model` | Stores the agent's provider and model. Tokens and cost are not added up (see [Usage figures](#usage-figures)). |
| `runtime.connected`, `runtime.disconnected`, `runtime.heartbeat` | none | No visible change. |

More details:

- **Statuses.** `OFFLINE`, `IDLE`, `AVAILABLE`, `THINKING`, `READING`, `RESEARCHING`, `CODING`, `WRITING`, `TESTING`, `USING_TOOL`, `WAITING`, `WAITING_APPROVAL`, `BLOCKED`, `DELEGATING`, `PHONE_CALL`, `WALKING`, `IN_MEETING`, `COFFEE_BREAK`, `CHATTING`, `REVIEWING`, `DELIVERING`, `DONE`, `ERROR`.
- **Agents the office does not know yet.** An event for an unknown agent adds it with a default profile (its id as name). An explicit `agentId` always names an agent, whatever the `source`. An event with a `runtime:` source and no `agentId` is about the runtime itself and adds no agent. Registering agents first (with `agent.registered` or the `agents` prop) gives them their real name, role title and workspace.
- **Roles.** `role` accepts the built-in roles of the demo team (`boss`, `tech_lead`, `research_lead`, `backend_engineer`, `frontend_engineer`, `qa_engineer`, `security_analyst`) and defaults to `custom`. A `custom` agent shows its `roleTitle`; the other roles show their `role.*` text, and `boss` shows the `role.boss` text in place of the name.
- **Meeting rooms.** Meeting Room A, Meeting Room B and, as a fallback, the Director Suite, with 4 seats each. When no room is free or the group has more than 4 participants, the meeting starts at once and participants stay where they are.
- **After a meeting** each participant walks back to the workspace from its profile. An agent without a workspace returns to where it was before the meeting.
- **Aliases.** `message.sent` is read as `agent.message.sent`; `agent.phone_call.started` and `meeting.room.reserved` as `meeting.started`; `agent.phone_call.ended` as `meeting.ended`; `meeting.decision` as `meeting.message`; `task.started`, `approval.approved` and `artifact.created` as `task.progress`; `approval.requested` as `task.blocked`.
- **Timing.** When several events arrive together (the first render, a rebuild, a seek), they keep their relative timing: an event 10 seconds older than the newest one is applied as if it happened 10 seconds ago. Rebuilding a long run therefore shows only the bubbles and walks that are still recent.

## Message kinds and speech bubbles

`MESSAGE_KINDS` lists what a message does in a conversation:

| Kind | English header | Spanish header |
|---|---|---|
| `statement` | SAYS | DICE |
| `proposal` | PROPOSES | PROPONE |
| `question` | ASKS | PREGUNTA |
| `answer` | ANSWERS | RESPONDE |
| `objection` | OBJECTS | OBJETA |
| `critique` | CRITIQUES | CRITICA |
| `agreement` | AGREES | ACUERDA |
| `summary` | SUMMARIZES | RESUME |
| `decision` | DECIDES | DECIDE |

- `meeting.message` carries the kind in `payload.type`. It is optional and defaults to `statement`.
- `agent.message.sent` accepts an optional `payload.kind`. The office never guesses a kind: without one, the header follows the agent's status (`MEETING` in a meeting, `CALL` on a call, `SOCIAL · SIMULATED` for simulated chats in showcase mode, `ACTIVITY` otherwise).

A bubble reads `Speaker · HEADER`, or `Speaker → Target · HEADER` when the message has a target. The speaker is the first word of the agent name. The text wraps to at most two lines and ends with an ellipsis when it is longer. Each agent shows one bubble at a time: a new message replaces the previous one, and it stays for `bubbleDurationMs`.

## Workspaces

`workspace` (in `agent.registered`, `agent.updated`, `agent.status.changed` and `AgentProfile`) accepts these values. Any other value is ignored, and the agent stays where it is.

| Workspace | Room label (en) | Room label (es) |
|---|---|---|
| `boss_office` | DIRECTOR SUITE | DIRECCIÓN |
| `leads_area` | ARCHITECTURE | ARQUITECTURA |
| `development` | ENGINEERING | INGENIERÍA |
| `qa_lab` | QA LAB | LAB QA |
| `research_area` | RESEARCH LIBRARY | BIBLIOTECA I+D |
| `server_room` | MODEL OPS | MODEL OPS |
| `meeting_room` | MEETING ROOM A | SALA DE REUNIÓN A |
| `meeting_room_b` | MEETING ROOM B | SALA DE REUNIÓN B |
| `break_room` | ESPRESSO BAR | CAFÉ ESPRESSO |

`overflow_floor` is also accepted: it is the stairway spot of the demo app's second floor. The embedded office has no second floor, so use one of the rooms above. Agents that share a room stand side by side.

## Translations

Every visible text comes from a catalog of keys. English and Spanish are built in, and you can rename or translate anything:

- `locale` picks the built-in catalog: a locale starting with `es` (`es`, `es-CO`, `es-MX`...) uses Spanish, anything else English.
- `messages` overrides single keys: `{ 'rooms.development': 'PLATFORM TEAM' }`.
- `t` plugs in your own translate function (i18next, FormatJS and similar).

For each key, the office uses the first of:

1. `t(key, params)`, when it returns a non-empty string different from the key. The string is used as is, so `t` fills placeholders itself.
2. `messages[key]`.
3. The built-in catalog of `locale`.
4. The English catalog.

Placeholders use `{name}` and are filled by `formatMessage`. A placeholder without a value stays as written.

```tsx
const messages = useMemo(() => ({ 'rooms.development': 'PLATFORM TEAM', 'office.empty': 'No agents yet' }), []);

<AgentOffice events={events} locale="en" messages={messages} />
```

With i18next, keep the office keys under a prefix of your own and answer only the keys you have:

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

`ReplayControls` and `recordReplay` accept the same `locale`, `messages` and `t`. `createOfficeTranslator({ locale, messages, t })` returns the same translate function the components use, `builtInMessages(locale)` returns a built-in catalog, `OFFICE_MESSAGES` holds both catalogs (`en`, `es`) and `isOfficeMessageKey(key)` checks a key.

### Message keys

There are 116 keys. The `screen.tokenFlow`, `screen.telemetry`, `screen.open`, `canvas.modelOps`, `canvas.showTimeline`, `canvas.hideTimeline` and `modelOps.*` keys belong to the demo app's Model Ops console and timeline; the embedded office does not show them.

#### `rooms.*` (10)

| Key | English | Spanish |
|---|---|---|
| `rooms.boss_office` | DIRECTOR SUITE | DIRECCIÓN |
| `rooms.meeting_room` | MEETING ROOM A | SALA DE REUNIÓN A |
| `rooms.meeting_room_b` | MEETING ROOM B | SALA DE REUNIÓN B |
| `rooms.server_room` | MODEL OPS | MODEL OPS |
| `rooms.leads_area` | ARCHITECTURE | ARQUITECTURA |
| `rooms.development` | ENGINEERING | INGENIERÍA |
| `rooms.qa_lab` | QA LAB | LAB QA |
| `rooms.research_area` | RESEARCH LIBRARY | BIBLIOTECA I+D |
| `rooms.break_room` | ESPRESSO BAR | CAFÉ ESPRESSO |
| `rooms.lounge` | TEAM LOUNGE | SALA DEL EQUIPO |

#### `furniture.*` (6)

| Key | English | Spanish |
|---|---|---|
| `furniture.f_boss_screen` | Objectives Wall | Muro de objetivos |
| `furniture.f_server_desk` | Token Telemetry | Telemetría de tokens |
| `furniture.f_research_table` | Study Table | Mesa de estudio |
| `furniture.f_coffee_table_a` | Table A | Mesa A |
| `furniture.f_coffee_table_b` | Table B | Mesa B |
| `furniture.f_lounge_screen` | Lounge Display | Pantalla del salón |

#### `screen.*` (7)

| Key | English | Spanish |
|---|---|---|
| `screen.meetingActive` | TEAM COORDINATION | COORDINACIÓN |
| `screen.meetingIdle` | CONFERENCE READY | SALA LISTA |
| `screen.qa` | TEST AUTOMATION | PRUEBAS AUTOMÁTICAS |
| `screen.status` | SYSTEM STATUS | ESTADO DEL SISTEMA |
| `screen.tokenFlow` | MODEL OPS · LIVE TOKEN FLOW | MODEL OPS · FLUJO DE TOKENS |
| `screen.telemetry` | MODEL OPS · LIVE TELEMETRY | MODEL OPS · TELEMETRÍA |
| `screen.open` | OPEN | ABRIR |

#### `status.*` (23)

| Key | English | Spanish |
|---|---|---|
| `status.OFFLINE` | Offline | Desconectado |
| `status.IDLE` | Idle | En espera |
| `status.AVAILABLE` | Available | Disponible |
| `status.THINKING` | Thinking | Pensando |
| `status.READING` | Reading | Leyendo |
| `status.RESEARCHING` | Researching | Investigando |
| `status.CODING` | Coding | Programando |
| `status.WRITING` | Writing | Escribiendo |
| `status.TESTING` | Testing | Probando |
| `status.USING_TOOL` | Using a tool | Usando una herramienta |
| `status.WAITING` | Waiting | Esperando |
| `status.WAITING_APPROVAL` | Waiting for approval | Esperando aprobación |
| `status.BLOCKED` | Blocked | Bloqueado |
| `status.DELEGATING` | Delegating | Delegando |
| `status.PHONE_CALL` | On a call | En llamada |
| `status.WALKING` | Walking | Caminando |
| `status.IN_MEETING` | In a meeting | En reunión |
| `status.COFFEE_BREAK` | Coffee break | Pausa para café |
| `status.CHATTING` | Chatting | Conversando |
| `status.REVIEWING` | Reviewing | Revisando |
| `status.DELIVERING` | Delivering | Entregando |
| `status.DONE` | Done | Terminado |
| `status.ERROR` | Error | Error |

#### `role.*` (8)

| Key | English | Spanish |
|---|---|---|
| `role.boss` | Director | Dirección |
| `role.tech_lead` | Tech lead | Líder técnico |
| `role.research_lead` | Research | Investigación |
| `role.backend_engineer` | Backend | Backend |
| `role.frontend_engineer` | Frontend | Frontend |
| `role.qa_engineer` | QA | QA |
| `role.security_analyst` | Security | Seguridad |
| `role.custom` | Agent | Agente |

#### `bubble.*` (4)

| Key | English | Spanish |
|---|---|---|
| `bubble.meeting` | MEETING | REUNIÓN |
| `bubble.phone` | CALL | LLAMADA |
| `bubble.social` | SOCIAL · SIMULATED | SOCIAL · SIMULADO |
| `bubble.activity` | ACTIVITY | ACTIVIDAD |

#### `kind.*` (9)

| Key | English | Spanish |
|---|---|---|
| `kind.statement` | SAYS | DICE |
| `kind.proposal` | PROPOSES | PROPONE |
| `kind.question` | ASKS | PREGUNTA |
| `kind.answer` | ANSWERS | RESPONDE |
| `kind.objection` | OBJECTS | OBJETA |
| `kind.critique` | CRITIQUES | CRITICA |
| `kind.agreement` | AGREES | ACUERDA |
| `kind.summary` | SUMMARIZES | RESUME |
| `kind.decision` | DECIDES | DECIDE |

#### `canvas.*` (11)

| Key | English | Spanish |
|---|---|---|
| `canvas.aria` | Animated agent office. The list of agents and their status is available as text. | Oficina animada de agentes. La lista de agentes y su estado está disponible como texto. |
| `canvas.toolbar` | Office view controls | Controles de la vista |
| `canvas.rotateLeft` | Rotate office left | Girar oficina a la izquierda |
| `canvas.rotateRight` | Rotate office right | Girar oficina a la derecha |
| `canvas.fit` | Fit full office | Ajustar oficina completa |
| `canvas.zoomOut` | Zoom out | Alejar |
| `canvas.zoomIn` | Zoom in | Acercar |
| `canvas.zoomLevel` | Zoom {percent}% | Zoom {percent}% |
| `canvas.showTimeline` | Show activity timeline | Mostrar actividad |
| `canvas.hideTimeline` | Hide activity timeline | Ocultar actividad |
| `canvas.modelOps` | Model Ops console (tokens and telemetry) | Consola Model Ops (tokens y telemetría) |

#### `modelOps.*` (18)

| Key | English | Spanish |
|---|---|---|
| `modelOps.rack.openai` | OpenAI server node | Nodo servidor OpenAI |
| `modelOps.rack.openaiDetail` | Prompt and reasoning tokens | Tokens de prompts y razonamiento |
| `modelOps.rack.anthropic` | Anthropic server node | Nodo servidor Anthropic |
| `modelOps.rack.anthropicDetail` | Code and UI work | Código e interfaz |
| `modelOps.rack.gemini` | Google Gemini server node | Nodo servidor Google Gemini |
| `modelOps.rack.geminiDetail` | Long context work | Trabajo con contexto largo |
| `modelOps.rack.local` | On-premise local rack | Rack local on-premise |
| `modelOps.rack.localDetail` | Local compute without cloud cost | Cómputo local sin costo de nube |
| `modelOps.noc` | Model Ops central screen | Pantalla central Model Ops |
| `modelOps.nocDetail` | Live view of the global token flow | Flujo global de tokens en vivo |
| `modelOps.workstation` | Model Ops telemetry workstation | Estación de telemetría Model Ops |
| `modelOps.workstationDetail` | Latency, cache and throughput monitoring | Monitoreo de latencia, caché y rendimiento |
| `modelOps.plaque` | Central operations console | Consola central de operaciones |
| `modelOps.plaqueDetail` | Open the interactive token usage panel | Abrir el panel interactivo de consumo de tokens |
| `modelOps.room` | Model Ops and token center | Sala Model Ops y centro de tokens |
| `modelOps.roomDetail` | LLM infrastructure and usage monitoring | Infraestructura LLM y monitoreo de consumo |
| `modelOps.open` | Open Model Ops console | Abrir consola Model Ops |
| `modelOps.hint` | Click to inspect token usage | Haz clic para revisar el consumo de tokens |

#### `office.*` (5)

| Key | English | Spanish |
|---|---|---|
| `office.label` | Agent office | Oficina de agentes |
| `office.agentsHeading` | Agents in the office | Agentes en la oficina |
| `office.agentLine` | {name}, {role}: {status} | {name}, {role}: {status} |
| `office.agentLineNoRole` | {name}: {status} | {name}: {status} |
| `office.empty` | Waiting for agent activity | Esperando actividad de los agentes |

#### `usage.*` (6)

| Key | English | Spanish |
|---|---|---|
| `usage.title` | Usage | Consumo |
| `usage.tokens` | Tokens | Tokens |
| `usage.inputTokens` | Input tokens | Tokens de entrada |
| `usage.outputTokens` | Output tokens | Tokens de salida |
| `usage.cost` | Cost | Costo |
| `usage.unknown` | unknown | desconocido |

#### `replay.*` (8)

| Key | English | Spanish |
|---|---|---|
| `replay.label` | Replay controls | Controles de repetición |
| `replay.play` | Play | Reproducir |
| `replay.pause` | Pause | Pausar |
| `replay.reset` | Back to start | Volver al inicio |
| `replay.position` | Replay position | Posición de la repetición |
| `replay.progress` | {percent}% | {percent}% |
| `replay.speed` | Speed | Velocidad |
| `replay.speedValue` | {speed}x | {speed}x |

#### `video.*` (1)

| Key | English | Spanish |
|---|---|---|
| `video.time` | Time: {time} | Hora: {time} |

## Theming

`theme="dark"` or `theme="light"` picks the palette. The HTML parts of the office (canvas toolbar, usage panel, empty state, replay controls) read `--av-*` custom properties. They are declared with zero specificity (`:where(...)`), so any selector of yours wins over them.

Theme variables:

| Variable | Dark | Light | Used for |
|---|---|---|---|
| `--av-bg` | `#090d16` | `#f8fafc` | Background of the office and the canvas area. |
| `--av-surface` | `#0f172a` | `#ffffff` | Toolbar and replay buttons. |
| `--av-surface-raised` | `rgba(15, 23, 42, 0.94)` | `rgba(255, 255, 255, 0.96)` | Floating panels: usage panel, empty state, replay bar, tooltip. |
| `--av-border` | `#1e293b` | `#e2e8f0` | Panel borders, toolbar separators, toolbar button hover. |
| `--av-border-strong` | `#334155` | `#cbd5e1` | Button borders, empty state border, speed selector. |
| `--av-text` | `#f1f5f9` | `#0f172a` | Main text. |
| `--av-text-muted` | `#94a3b8` | `#475569` | Secondary text and toolbar icons. |
| `--av-accent` | `#38bdf8` | `#0284c7` | Fit button, replay slider, focus ring. |
| `--av-accent-strong` | `#0ea5e9` | `#0369a1` | Play button and selected speed. |
| `--av-accent-contrast` | `#0f172a` | `#ffffff` | Text and icons on `--av-accent-strong`. |
| `--av-telemetry` | `#22d3ee` | `#0e7490` | Telemetry button and tooltip of the demo app. |
| `--av-live` | `#34d399` | `#059669` | Live indicator of the demo app. |
| `--av-active` | `#4f46e5` | `#4f46e5` | Pressed toolbar button. |
| `--av-shadow` | `0 12px 32px rgba(0, 0, 0, 0.35)` | `0 12px 32px rgba(15, 23, 42, 0.12)` | Shadow of floating panels. |

Shared variables (both themes):

| Variable | Default | Used for |
|---|---|---|
| `--av-radius` | `12px` | Corner radius of panels. |
| `--av-font-sans` | `system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif` | Text of the HTML parts. |
| `--av-font-mono` | `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` | Numbers and zoom level. |
| `--av-focus` | `2px solid var(--av-accent)` | Focus outline of buttons and the slider. |

To override them, add a class with `className` and set the variables on it. The office declares the theme once, on its root, so the toolbar and every panel inside inherit your values:

```css
.team-office,
.team-replay {
  --av-accent: #7c3aed;
  --av-accent-strong: #6d28d9;
  --av-radius: 8px;
}
```

```tsx
<>
  <AgentOffice className="team-office" events={events} />
  <ReplayControls className="team-replay" replay={replay} />
</>
```

Notes:

- The canvas drawing itself (floor, furniture, agents, name cards and bubbles) uses the built-in dark or light palette chosen by `theme`. The `--av-*` variables do not change it.
- No fonts are loaded. Canvas text asks for `"Plus Jakarta Sans"` and falls back to the browser's sans-serif font when your page does not provide it.
- Class names you can target: `av-office`, `av-theme-dark`, `av-theme-light`, `av-office-stage`, `av-office-empty`, `av-usage`, `av-usage-item`, `av-sr-only`, `av-canvas-root`, `av-toolbar`, `av-toolbar-sep`, `av-tool-btn`, `av-tool-btn--accent`, `av-tool-btn--active`, `av-zoom-level`, `av-stage`, `av-canvas`, `av-icon`, `av-replay`, `av-replay-btn`, `av-replay-btn--primary`, `av-replay-range`, `av-replay-progress`, `av-replay-speed`. The `av-tooltip*`, `av-tool-btn--telemetry` and `av-icon--live` classes are used by the demo app.

## Accessibility

- The office is a `<section>` named by `ariaLabel` (default: the `office.label` text).
- The canvas has `role="img"` and an `aria-label` (`canvas.aria`) that points to the text list.
- An agent list, announced politely (`aria-live="polite"`), names every agent with its role and status, for example "Atlas, Builder: Coding". With `showUsage`, each line also carries that agent's figures from `usage.byAgent`. The list stays visually hidden until it receives keyboard focus (Tab); then it opens as a panel of buttons.
- The toolbar (`role="toolbar"`) and the replay controls are real buttons with accessible names and a visible focus ring. The replay slider announces its progress, and the speed buttons use `aria-pressed`.
- With `prefers-reduced-motion: reduce`, nothing animates: agents move to their destination without walking, animated details stay still and button transitions are off.
- Keyboard selection: each agent in that list is a button (`aria-pressed` shows the selected one). Pressing it selects the agent and moves the camera to it, like a click on the canvas; pressing it again clears the selection. The office registers no global keyboard shortcuts.

## Usage figures

The office never computes, adds up or prices usage. It only displays the figures your app passes, and only when you ask:

```tsx
const usage = useMemo(() => ({
  total: { totalTokens: 18400, inputTokens: 15200, outputTokens: 3200, cost: 0.42, currency: 'USD' },
  byAgent: {
    planner: { totalTokens: 6100, cost: null },
    builder: { totalTokens: 12300, cost: 0.42, currency: 'USD' },
  },
}), []);

<AgentOffice events={events} showUsage usage={usage} />
```

`OfficeUsage` is `{ total?: UsageFigures; byAgent?: Record<string, UsageFigures> }`, and `UsageFigures` has `totalTokens`, `inputTokens`, `outputTokens`, `cost` and `currency` (all optional).

Display rules:

- `showUsage` is `false` by default. Without it, `usage` is ignored.
- `total` appears in a small panel in the top right corner: tokens and cost always, input and output tokens only when you send those fields.
- `byAgent` figures, keyed by agent id, appear in the accessible agent list.
- A missing value (`undefined`, `null` or not a finite number) is shown as "unknown" (`usage.unknown`), never as zero. `totalTokens` is not derived from input and output tokens: send it yourself.
- `cost` is formatted as money when `currency` is an ISO 4217 code such as `USD` or `EUR`, and as a plain number otherwise. Numbers follow `locale`.

`formatUsage(figures, locale, translate)`, `formatTokens` and `formatCost` return the same formatted values, so you can show them elsewhere in your UI.

If your app has no usage service, `summarizeUsage(events)` is an explicit opt-in helper. It only adds up the figures reported by `llm.usage` events and never prices tokens:

```tsx
const usage = useMemo(() => summarizeUsage(events), [events]);
```

- `totalTokens` is `inputTokens + outputTokens`. Token counts an event does not report count as zero.
- The `cost` is `null` (shown as "unknown") when any `llm.usage` event lacks a reported cost, or when events report different currencies. A partial sum is never shown.
- The same rules apply to each agent in `byAgent`, using only that agent's events.
- Without any `llm.usage` event, every figure is `null` (shown as "unknown"), not zero.

## Replay

`useEventReplay` plays a recorded run at its own pace and returns the visible slice, ready for `<AgentOffice events>`. It only reveals events; it never creates any. `ReplayControls` is an optional bar for it: play and pause, back to start, a position slider and speed buttons.

```tsx
import { AgentOffice, ReplayControls, useEventReplay, type OfficeEventInput } from '@warlockcode/agent-viewer';

export function RunReplay({ run }: { run: readonly OfficeEventInput[] }) {
  const replay = useEventReplay(run, { speed: 2, maxGapMs: 3000 });

  return (
    <div style={{ display: 'grid', gridTemplateRows: '1fr auto', gap: 8, height: 600 }}>
      <AgentOffice events={replay.events} />
      <ReplayControls replay={replay} speeds={[1, 2, 4, 8]} />
    </div>
  );
}
```

Keep `run` stable (state, a prop or `useMemo`): a new array starts the replay again from the beginning. Events are sorted by `timestamp`, and each one waits the time it waited in the original run, divided by the speed.

`useEventReplay(source, options)` options:

| Option | Default | Description |
|---|---|---|
| `speed` | `1` | Playback speed multiplier. |
| `autoPlay` | `false` | Start playing as soon as there are events. |
| `maxGapMs` | `5000` | Longest wait between two events, in event time. Longer silences are shortened. |
| `minGapMs` | `50` | Shortest wait between two events, so bursts stay readable. |

It returns an `EventReplay`:

| Field | Description |
|---|---|
| `events` | Events visible at the current position. |
| `position`, `total` | Number of visible events and of all events. |
| `progress` | From 0 to 1. |
| `playing`, `speed` | Current state. |
| `play()`, `pause()`, `toggle()` | Playback. `play()` at the end starts again from the beginning. |
| `reset()` | Pauses and goes back to the start. |
| `seek(ratio)` | Jumps to a position between 0 and 1. |
| `setSpeed(value)` | Changes the speed (positive numbers only). |

`ReplayControls` props: `replay` (required), `speeds` (default `[1, 2, 4]`), `locale`, `messages`, `t`, `theme` and `className`. You can also build your own controls from the `EventReplay` fields.

Seeking backwards rebuilds the office from the start of the run up to the new position. Thanks to the relative timing of batches, only the recent bubbles and walks show after a seek.

## Loading a log file

`parseEventLog(input)` reads a canonical JSONL V1 log (a `string`, `File` or `Blob`, up to `MAX_EVENT_LOG_SIZE_BYTES`, 25 MB) and validates every line. See [event-log.md](event-log.md) for the format.

```tsx
async function loadRun(file: File) {
  const result = await parseEventLog(file);
  if (result.issues.length > 0) console.warn(result.issues);
  return result.events; // sorted by timestamp, ready for useEventReplay
}
```

The result is `{ events, issues, totalLines, format }`. Invalid lines are reported in `issues` (`line`, `error`, `raw`) without stopping the parse. OTLP traces are not supported: they return no events and one issue saying that OTLP traces are not supported yet. The component has no built-in file drop; wire your own file input to `parseEventLog`.

## Video export

`recordReplay(options)` records a replay of a run into a video `Blob` in the browser, with `MediaRecorder` and `canvas.captureStream`. It draws on its own offscreen canvas, so the office on the page is not affected.

```tsx
import { isRecordingSupported, recordReplay, type OfficeEventInput } from '@warlockcode/agent-viewer';

async function exportRun(run: readonly OfficeEventInput[], signal: AbortSignal) {
  if (!isRecordingSupported()) return;
  const blob = await recordReplay({
    events: run,
    speed: 4,
    title: 'Synthetic review run',
    locale: 'en',
    onProgress: (progress) => console.log(`${Math.round(progress * 100)}%`),
    signal,
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = blob.type.includes('mp4') ? 'run.mp4' : 'run.webm';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
```

| Option | Default | Description |
|---|---|---|
| `events` | required | Events of the run. They are sorted by `timestamp`. |
| `agents` | none | Agent profiles, as in `<AgentOffice>`. |
| `mode` | `'professional'` | Office mode. |
| `speed` | `1` | Playback speed multiplier. |
| `fps` | `30` | Frames per second. |
| `width`, `height` | `1280`, `720` | Video size in pixels. |
| `maxGapMs` | `5000` | Longest wait between two events. |
| `tailMs` | `2000` | Time the last frame stays after the final event. |
| `maxDurationMs` | `600000` | Hard limit for the video length (10 minutes). |
| `theme` | `'dark'` | Palette. |
| `locale`, `messages`, `t` | none (English) | Texts, as in `<AgentOffice>`. |
| `title` | none | Drawn in the corner. Nothing is drawn when it is missing. |
| `showUsage`, `usage` | `false` | Draws the `usage.total` figures you pass. The export never computes usage. |
| `onProgress` | none | Called with a value from 0 to 1. |
| `signal` | none | `AbortSignal`. Aborting rejects the promise with an `AbortError`. |

Notes:

- Recording runs in real time: a video of one minute takes about one minute to record. Use `speed` and `maxGapMs` to shorten long runs, and `computeReplaySchedule(events, { speed, maxGapMs, tailMs, maxDurationMs })` to know the length in advance (`durationMs`).
- The format is the first one the browser supports among WebM (VP9, VP8) and MP4; `getSupportedMimeType()` tells you which.
- The promise rejects when the browser cannot record (`isRecordingSupported()` is `false`) or supports none of those formats.
- The video shows the time of the latest visible event (`video.time`).

## The office model without a React tree

`OfficeStore` and `buildOfficeSnapshot` derive the office from events without rendering anything: on a server, in tests or for your own exports.

```ts
import { buildOfficeSnapshot } from '@warlockcode/agent-viewer';

const snapshot = buildOfficeSnapshot(events, { agents, now: Date.now() });
for (const agent of snapshot.agents) {
  console.log(`${agent.name}: ${agent.status} in ${agent.workspace}`);
}
```

`buildOfficeSnapshot(events, options)` accepts `mode`, `bubbleMs`, `locale`, `agents` and `now`, and returns an `OfficeSnapshot`:

- `agents`: copies of the visible agents (`Agent`), with `status`, `statusText`, `workspace`, position, `currentTool`, `speechBubble` and the rest of their state. A bubble is visible while `speechBubble.expiresAt` is later than the current time.
- `meetings`: meetings with their participants, status, messages and decisions.
- `activeMeetingId`: the meeting in progress, or `null`.

The usage fields of `Agent` (`tokensInput`, `tokensOutput`, `cost`...) stay at zero, because the store never adds usage up.

For incremental work, keep a store:

```ts
import { OfficeStore } from '@warlockcode/agent-viewer';

const store = new OfficeStore({ mode: 'professional', bubbleMs: 6500, locale: 'en' });
store.sync(events, agents, Date.now()); // applies new events, or rebuilds when the list changed
store.tick(Date.now());                 // finishes walks and starts meetings whose participants arrived
const { agents: visible, meetings, activeMeetingId } = store.snapshot();
```

`sync` and `tick` return `true` when something changed. Each store is independent and keeps everything in memory.

The package entry point also exports the React components, so `react` must stay installed even when you only use the store.

## Event contract helpers

The office accepts `OfficeEventInput`: a full `CanonicalEvent`, a `CanonicalEventInput` (only `id`, `type` and `timestamp` are required, and `timestamp` may be an ISO 8601 string) or a legacy `ViewerEvent`.

- `validateCanonicalEvent(input)` checks an event strictly against the V1 contract and returns `{ success, data, issues }`.
- `normalizeCanonicalEvent(input)` completes a loose event without validating it.
- `SCHEMA_VERSION`, `CANONICAL_EVENT_TYPES`, `EVENT_TYPE_ALIASES`, `MESSAGE_KINDS` and `isMessageKind` describe the contract.

Contract fields used by the office in this version:

- `agent.message.sent` accepts an optional `kind`, one of `MESSAGE_KINDS`.
- `meeting.message` `type` is one of `MESSAGE_KINDS` (default `statement`).
- `llm.usage` accepts an optional `currency`, an ISO 4217 code of three uppercase letters such as `USD`.

The full contract is in [integration.md](integration.md) and [`canonicalContract.ts`](../src/integrations/canonicalContract.ts).

## API reference

Everything is exported from `@warlockcode/agent-viewer`. The stylesheet is `@warlockcode/agent-viewer/style.css`.

| Area | Values | Types |
|---|---|---|
| Office | `AgentOffice` | `AgentOfficeProps` |
| Office model | `OfficeStore`, `buildOfficeSnapshot` | `AgentProfile`, `OfficeEventInput`, `OfficeMode`, `OfficeSnapshot`, `OfficeStoreOptions` |
| Replay | `useEventReplay`, `ReplayControls` | `EventReplay`, `EventReplayOptions`, `ReplayControlsProps` |
| Usage | `formatUsage`, `formatTokens`, `formatCost`, `summarizeUsage` | `OfficeUsage`, `UsageFigures`, `FormattedUsageItem` |
| Texts | `OFFICE_MESSAGES`, `createOfficeTranslator`, `formatMessage`, `builtInMessages`, `isOfficeMessageKey` | `OfficeMessageKey`, `OfficeMessages`, `OfficeMessageParams`, `OfficeTranslate`, `OfficeTranslatorOptions`, `HostTranslate` |
| Core types | none | `Agent`, `AgentRole`, `AgentStatus`, `AgentMood`, `WorkspaceZone`, `ViewerEvent`, `Task`, `TaskStatus`, `Meeting`, `MeetingMessage` |
| Event contract V1 | `SCHEMA_VERSION`, `CANONICAL_EVENT_TYPES`, `EVENT_TYPE_ALIASES`, `MESSAGE_KINDS`, `isMessageKind`, `normalizeCanonicalEvent`, `validateCanonicalEvent` | `CanonicalEvent`, `CanonicalEventInput`, `CanonicalEventType`, `LegacyEventType`, `EventSeverity`, `MessageKind`, `ValidationIssue`, `ValidationResult` |
| Live stream | `connectEventStream` | `RealtimeConnection`, `RealtimeStatus`, `RealtimeConnectionOptions` |
| Log files | `parseEventLog`, `MAX_EVENT_LOG_SIZE_BYTES` | `EventLogParseResult`, `EventLogParseIssue` |
| Video | `recordReplay`, `computeReplaySchedule`, `isRecordingSupported`, `getSupportedMimeType` | `RecordReplayOptions`, `ReplaySchedule` |

`connectEventStream(baseUrl, onEvent, onStatus?, options?)` opens an `EventSource` on `${baseUrl}/api/v1/events/stream`, calls `onEvent` for every valid event and reconnects with backoff, resuming from the last event id. Options: `token` (sent as the `token` query parameter), `maxReconnectAttempts` (default unlimited), `initialBackoffMs` (1000), `maxBackoffMs` (15000) and `heartbeatTimeoutMs` (35000). `onStatus` receives `connecting`, `connected`, `reconnecting`, `disconnected`, `error` or `closed`. The returned connection has `close()`, `status()` and `getLastEventId()`.

## Isolation guarantees

- Two offices on the same page never share state: each `<AgentOffice>` owns its store.
- Nothing is read from or written to `localStorage` or any other browser storage.
- No timer invents data. The office checks every 250 ms whether walks finished and meetings can start; only `mode="showcase"` adds simulated activity, and it is marked as simulated.
- No global keyboard shortcuts.
- Nothing runs on import, and no styles are injected.
- In frameworks with server components, render `<AgentOffice>` from a client component (for example with `'use client'` in Next.js), because it uses hooks and a canvas.

The demo app of this repository (`npm run dev`) is built separately with `npm run build`. The library is built with `npm run build:lib` into `dist-lib/`.

## Versioning

The library follows [Semantic Versioning](https://semver.org/). While it is at 0.x, the API may still change: a minor release (0.3.0, 0.4.0...) can include breaking changes, and they are listed in the [CHANGELOG](../CHANGELOG.md). A range such as `^0.2.0` accepts only 0.2.x patch releases.
