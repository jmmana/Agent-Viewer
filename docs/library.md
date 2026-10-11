# Agent Viewer library guide

`@warlockcode/agent-viewer` puts the Agent Viewer office inside your own React app. The office is a Canvas2D scene drawn only from the events you pass: the agents your runtime registers, their statuses, the tools they use, the messages they send and the meetings they hold.

This guide covers version **0.5.0**. Leer en español: [library.es.md](library.es.md).

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

The runtime dependencies are `lucide-react` (icons), `zod` (strict event validation) and `express` (the server of the `agent-viewer` command; the library modules never import it, so it never reaches your bundle). The package declares Node.js 22.13 or later in `engines`. TypeScript declarations are included.

Publication on npm is coming soon. Until then, install the package from the GitHub release asset:

```bash
npm install https://github.com/jmmana/Agent-Viewer/releases/download/v0.5.0/warlockcode-agent-viewer-0.5.0.tgz
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
| `showUsageBadges` | `boolean` | `false` | Draws a compact usage badge on each agent card from `usage.byAgent`. Independent of `showUsage`. See [Usage figures](#usage-figures). |
| `usage` | `OfficeUsage` | none | Usage figures computed by your app. The office never computes them. |
| `meetingUsage` | `MeetingUsage` | none | Per-meeting usage figures computed by your app, keyed by meeting id. Shown only while `showUsage` is also `true`. See [Meeting figures](#meeting-figures). |
| `showCallDetails` | `boolean` | `false` | Shows a read-only panel with the calls of the selected agent, from `agentCallDetails`. Independent of `showUsage`/`showUsageBadges`. See [Call details](#call-details). |
| `agentCallDetails` | `AgentCallDetails` | none | Call metadata per agent id, computed and paged by your app. Only the selected agent's entry is read. |
| `selectedAgentId` | `string \| null` | none | Controlled selection. Leave it undefined to let the office keep its own. When it changes, the camera centers on that agent. |
| `onSelectAgent` | `(agentId: string \| null) => void` | none | Called when the viewer clicks an agent on the canvas, chooses it from the agent list, or closes the call details panel (close button or `Escape`). |
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
| `llm.failed` | `provider`, `model` | Stores the agent's provider and model. No status change; tokens and cost are never added up. |
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

There are 156 keys. The `screen.tokenFlow`, `screen.telemetry`, `screen.open`, `canvas.modelOps`, `canvas.showTimeline`, `canvas.hideTimeline`, `modelOps.*` and `crew.*` keys belong to the demo app (the Model Ops console and timeline, and the separate Crew renderer under `src/crew/`); the embedded office does not show them. As of issue #79, Model Ops reads the server's usage ledger: that read client and its ledger-backed tab components live under `src/integrations/ledgerClient.ts` and `src/components/modelOps/`, both demo-app-only. `@warlockcode/agent-viewer` ships no ledger client, no usage-ledger endpoint reference and no Model Ops component (enforced by `tests/lib/libraryIsolation.test.ts`).

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

#### `usage.*` (31)

| Key | English | Spanish |
|---|---|---|
| `usage.title` | Usage | Consumo |
| `usage.tokens` | Tokens | Tokens |
| `usage.inputTokens` | Input tokens | Tokens de entrada |
| `usage.outputTokens` | Output tokens | Tokens de salida |
| `usage.cacheRead` | Cache read | Lectura de caché |
| `usage.cacheWrite` | Cache write | Escritura de caché |
| `usage.cacheReadTokens` | Cache read tokens | Tokens de caché leídos |
| `usage.cacheWriteTokens` | Cache write tokens | Tokens de caché escritos |
| `usage.reasoningTokens` | Reasoning tokens | Tokens de razonamiento |
| `usage.cost` | Cost | Costo |
| `usage.costSource` | Cost source | Origen del costo |
| `usage.costSource.providerReported` | provider reported | informado por el proveedor |
| `usage.costSource.estimated` | estimated | estimado |
| `usage.failedCalls` | Failed calls | Llamadas fallidas |
| `usage.badge.estimatedMark` | est. | est. |
| `usage.badge.failed` | {count} failed | {count} fallidas |
| `usage.badge.lessThan` | <{value} | <{value} |
| `usage.unknown` | unknown | desconocido |
| `usage.partialTokens` | {value} (unknown in {count} of {calls} calls) | {value} (desconocido en {count} de {calls} llamadas) |
| `usage.partialCost` | + {count} calls with unknown cost | + {count} llamadas con costo desconocido |
| `usage.partialShort` | + unknown | + desconocido |
| `usage.mixedCurrencies` | mixed currencies | múltiples monedas |
| `usage.mixedSources` | mixed sources | múltiples fuentes |
| `usage.noCurrency` | Currency not reported | Moneda no reportada |
| `usage.estimatedShort` | estimated | estimado |
| `usage.sourceUnknown` | Source unknown | Fuente desconocida |
| `usage.calls` | Model calls | Llamadas al modelo |
| `usage.unattributedCalls` | Not attributed to this meeting | Sin atribuir a esta reunión |
| `usage.meeting` | Meeting spend | Gasto de la reunión |
| `usage.meetingsHeading` | Meetings | Reuniones |
| `usage.meetingLine` | {title}: {usage} | {title}: {usage} |

#### `calls.*` (12)

| Key | English | Spanish |
|---|---|---|
| `calls.title` | Call details: {name} | Detalle de llamadas: {name} |
| `calls.close` | Close call details | Cerrar el detalle de llamadas |
| `calls.empty` | No call details provided | No se proporcionó detalle de llamadas |
| `calls.provider` | Provider | Proveedor |
| `calls.model` | Model | Modelo |
| `calls.status` | Status | Estado |
| `calls.status.ok` | OK | Correcta |
| `calls.status.failed` | Failed | Fallida |
| `calls.status.rate_limited` | Rate limited | Limitada por frecuencia |
| `calls.latency` | Latency | Latencia |
| `calls.latencyValue` | {value} ms | {value} ms |
| `calls.requestId` | Request id | Id de solicitud |

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

#### `crew.*` (3)

| Key | English | Spanish |
|---|---|---|
| `crew.walkFallback` | Walk atlas unavailable; the original pose remains visible. | Atlas de caminar no disponible; se conserva la pose original. |
| `crew.walkDemo` | DEMO: synthetic read-only CEO transit snapshot. | DEMO: snapshot sintético de tránsito del CEO, de solo lectura. |
| `crew.walkPrototype` | 2.5D PROTOTYPE: CEO walk frames follow reported transit in four directions; final art and physical paths are pending. | PROTOTIPO 2.5D: los cuadros de caminar del CEO siguen el tránsito reportado en cuatro direcciones; arte final y trayectorias físicas pendientes. |

Like `modelOps.*`, these keys belong to the demo app's separate Crew renderer (`src/crew/`), never `@warlockcode/agent-viewer`.

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
- Class names you can target: `av-office`, `av-theme-dark`, `av-theme-light`, `av-office-stage`, `av-office-empty`, `av-usage-stack`, `av-usage`, `av-usage-item`, `av-meeting-usage`, `av-meeting-usage-title`, `av-sr-only`, `av-canvas-root`, `av-toolbar`, `av-toolbar-sep`, `av-tool-btn`, `av-tool-btn--accent`, `av-tool-btn--active`, `av-zoom-level`, `av-stage`, `av-canvas`, `av-icon`, `av-replay`, `av-replay-btn`, `av-replay-btn--primary`, `av-replay-range`, `av-replay-progress`, `av-replay-speed`, `av-call-details`, `av-call-details-header`, `av-call-details-close`, `av-call-details-empty`, `av-call-details-list`, `av-call-item`, `av-call-row`, `av-call-request-id`. The `av-tooltip*`, `av-tool-btn--telemetry` and `av-icon--live` classes are used by the demo app.

## Accessibility

- The office is a `<section>` named by `ariaLabel` (default: the `office.label` text).
- The canvas has `role="img"` and an `aria-label` (`canvas.aria`) that points to the text list.
- An agent list, announced politely (`aria-live="polite"`), names every agent with its role and status, for example "Atlas, Builder: Coding". With `showUsage` or `showUsageBadges` (either one), each line also carries that agent's exact figures from `usage.byAgent`, so the screen-reader text always agrees with a visible badge even when the badge itself is hidden below zoom 0.55. The list stays visually hidden until it receives keyboard focus (Tab); then it opens as a panel of buttons.
- The toolbar (`role="toolbar"`) and the replay controls are real buttons with accessible names and a visible focus ring. The replay slider announces its progress, and the speed buttons use `aria-pressed`.
- With `prefers-reduced-motion: reduce`, nothing animates: agents move to their destination without walking, animated details stay still and button transitions are off.
- Keyboard selection: each agent in that list is a button (`aria-pressed` shows the selected one). Pressing it selects the agent and moves the camera to it, like a click on the canvas; pressing it again clears the selection. The office registers no global keyboard shortcuts, except `Escape` inside the open call details panel (`showCallDetails`), which only closes that panel.
- The call details panel (`showCallDetails`) is a `<section>` named by `calls.title`; opening it does not move focus into it or trap it, so a keyboard user who opened it from the agent list keeps focus there and `Escape` closes it without any extra step. It has no `aria-live` region: it is not a notification, so neither opening it nor a new figure arriving while it is open is announced.

## Usage figures

### The four rules

These four rules hold for every usage-related prop (`showUsage`, `showUsageBadges`, `showCallDetails`, `meetingUsage` and the usage option of `recordReplay` alike). This is the one place that states them together; the rest of this chapter only explains the mechanics.

1. **The host computes, the component displays.** Figures arrive through props. The component never sums, prices, converts currency or compares against a limit: there is no prop that makes the office add events up itself.
2. **Hidden by default.** `showUsage`, `showUsageBadges` and `showCallDetails` are each `false` until the host opts in. Nothing about usage renders before then, whatever `usage`, `meetingUsage` or `agentCallDetails` carry.
3. **Unknown is never zero.** A missing or `null` figure is shown as "unknown" (`usage.unknown`), never as `0`. A real reported `0` still shows `0`.
4. **Metadata only.** The call detail panel shows model, provider, tokens, `requestId`, latency, status and cost. `AgentCallDetail` has no field for a prompt, a completion or tool arguments, and the panel reads only its named fields, never the whole object, so an extra key can never leak through.

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

`OfficeUsage` is `{ total?: UsageFigures; byAgent?: Record<string, UsageFigures> }`. `UsageFigures` has `totalTokens`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`, `cost`, `currency`, `costSource` (`'provider-reported' | 'estimated' | 'unknown'`) and `failedCalls` (all optional and nullable).

Display rules:

- `showUsage` is `false` by default. Without it, `usage` is ignored.
- `total` appears in a small panel in the top right corner: tokens and cost always, every other field only when you send that key.
- `byAgent` figures, keyed by agent id, appear in the accessible agent list.
- A missing value (`undefined`, `null` or not a finite number) is shown as "unknown" (`usage.unknown`), never as zero. `totalTokens` is not derived from input and output tokens: send it yourself.
- `cost` is formatted as money when `currency` is an ISO 4217 code such as `USD` or `EUR`, and as a plain number otherwise. Numbers follow `locale`.
- `costSource` is shown as "provider reported" or "estimated"; `null`, missing or an unrecognized value is shown as unknown. `failedCalls` follows the same token formatting rules as any other count.

`formatUsage(figures, locale, translate)`, `formatTokens` and `formatCost` return the same formatted values, so you can show them elsewhere in your UI.

### Usage badges on the canvas

`showUsageBadges` (`false` by default, independent of `showUsage`) draws a compact badge on every agent card from `usage.byAgent`:

```tsx
<AgentOffice events={events} usage={usage} showUsageBadges />
```

- An agent with **no** `usage.byAgent` entry gets **no badge**: that is neither a zero nor a claim, so the library draws nothing rather than guess. An agent with an entry whose fields are missing or `null` gets a badge that reads "unknown" for those fields.
- The badge shows the compact total tokens (`9,840` below 10,000, `12.3K` / `12,3 mil` from 10,000 up), the cost (`$0.42`, `<$0.01` for a positive cost under half a cent, `$0.00` for a reported zero), an `est.` mark when `costSource` is `'estimated'`, and a `N failed` chip when `failedCalls` is greater than 0. None of this is color-only: every state has its own text.
- Badges live on the agent card, so they are hidden below camera zoom 0.55 unless the agent is selected, hovered or speaking, exactly like the card itself. The accessible agent list (above) is the always-available channel with the exact figures.
- The canvas receives only the pre-formatted strings `formatUsageBadge` produces, never a number: it does not import the demo app's token aggregator and adds up nothing itself.
- `formatUsageBadge(figures, locale, translate)` returns `{ tokens, cost, costLabel, estimated, failed, text }` and is exported if you want the same badge content elsewhere in your UI; `UsageBadge` and `UsageCostSource` are exported types.

If your app has no usage service, `summarizeUsage(events)` is an explicit opt-in helper. It only adds up the figures reported by `llm.usage` and `llm.failed` events and never prices tokens:

```tsx
const usage = useMemo(() => summarizeUsage(events), [events]);
```

- Events are deduplicated by `id`, like the office and the server do: the first event with a given id wins, whatever its type or agent, and later events with that id are ignored (SSE reconnects, retries and merged replay files repeat events). An event without an `id` (or with an empty or non-string one) cannot be matched, so each one is counted; the same object passed twice counts once.
- Token counts come from the raw payload. A count is reported only when it is a non-negative integer. If any event does not report `inputTokens`, the `inputTokens` figure is `null` (shown as "unknown"), and the same goes for `outputTokens`. `totalTokens` is `inputTokens + outputTokens` only when both are known, and `null` otherwise.
- `cacheReadTokens`, `cacheWriteTokens` and `reasoningTokens` follow a similar rule but with a third state: the key is **omitted** when no counted event reports it at all, the **sum** when every counted event does, and `null` when only some do. The deprecated `cachedTokens` field is read as `cacheReadTokens` when the new field is absent.
- `costSource` is omitted when no counted event ever sends the key. Once some event does, a missing or unrecognized value on any event counts as `'unknown'` (the same default the canonical contract applies), and the figure is the common value when every event agrees, `null` when they do not; so a mix of an explicit `'estimated'` and an event that said nothing yields `null`.
- `failedCalls` counts `llm.failed` events, independently of `llm.usage`: an agent with only failed calls and no successful ones still gets a `byAgent` entry, with every other figure `null`. The key is omitted when there are no failed calls to report.
- A cost is reported only when it is a finite, non-negative number, and a currency counts only when it is an ISO 4217 code (`^[A-Z]{3}$`, such as `USD`). Values like `'usd'`, `'dollars'` or `''` count as no currency. Costs are never converted:

  | Costs seen (after deduplication) | `cost` | `currency` |
  |---|---|---|
  | No `llm.usage` event | `null` | `undefined` |
  | Any event without a reported cost | `null` | `undefined` |
  | All costs in one ISO currency, e.g. all `USD` | sum | `'USD'` |
  | Two or more ISO currencies, e.g. `USD` and `EUR` | `null` | `undefined` |
  | At least one ISO currency and at least one cost without currency | `null` | `undefined` |
  | All costs reported, none with a currency | sum | `undefined` (shown as a plain number) |

- `currency` is set only when `cost` is known, so no currency label ever appears next to an unknown cost. A partial sum is never shown.
- The same rules apply to each agent in `byAgent`, using only that agent's events: when one agent lacks a figure, only that agent and the run total become unknown.
- Without any `llm.usage` event, every figure is `null` (shown as "unknown"), not zero, and `byAgent` is `{}` (unless some agent has `llm.failed` events of its own, in which case it gets an entry with `failedCalls` set and everything else `null`).

**Usage correlation fields (issue #64).** `llm.usage` and `llm.failed` payloads may carry `traceId`, `parentId`, `toolCallId`, `meetingId`, `userId` and `tags` (see [docs/integration.md](integration.md#correlation-and-attribution-fields-issue-64) for the validation rules). `summarizeUsage` does not read them: its output is identical whether or not an event carries these fields, and it never groups by them. No library component renders `userId` or `tags`, since `userId` is pseudonymous attribution and `tags` can be used for internal labels, neither meant for the embedded display. The library exports the matching limits and type as values and a type only, with no new behavior: `CORRELATION_ID_MAX_LENGTH` (128), `USAGE_TAGS_MAX` (20), `USAGE_TAG_MAX_LENGTH` (64) and the type `UsageCorrelation`.

### Meeting figures

A meeting is where several agents spend together; `meetingUsage` answers "what did this meeting cost" the same way `usage.byAgent` answers it per agent, from your app's own figures only (issue #81):

```tsx
import type { MeetingUsage } from '@warlockcode/agent-viewer';

const meetingUsage = useMemo<MeetingUsage>(() => ({
  'm-1': { calls: 14, totalTokens: 23550, cost: 0.0412, currency: 'USD', callsWithoutCost: 2, unattributedCalls: 3 },
}), []);

<AgentOffice events={events} showUsage usage={usage} meetingUsage={meetingUsage} />
```

- `MeetingUsageFigures` extends `UsageFigures` with `calls` (model calls attributed to the meeting), `callsWithoutCost` (of `calls`, how many had no cost: the cost figure is marked partial when this is greater than `0`) and `unattributedCalls` (calls you could not attribute to the meeting, shown on its own line, never added to `calls` or to any other figure). `MeetingUsage` is `Record<meetingId, MeetingUsageFigures>`.
- Hidden unless `showUsage` is `true` and `meetingUsage` has an entry for the shown meeting. The shown meeting is the active one (`snapshot.activeMeetingId`) when it has an entry; otherwise, since the active id clears the moment a meeting ends, it is the meeting with the greatest `startedAt` that has an entry, so a just-concluded meeting still shows its figures. An entry whose key matches no meeting in the current snapshot is ignored.
- A new `dl.av-meeting-usage` panel, placed under the per-run `av-usage` panel, shows the meeting's title and the same row rules as `usage.byAgent`: a missing or `null` field reads "unknown", a real `0` shows `0`, and an omitted key shows no row. `unattributedCalls` is shown when you send a number (including `0`) and omitted entirely when the key is absent.
- The visually hidden list gets a second heading, "Meetings", with one line per meeting that has an entry, so screen readers get the same figures as the visible panel.
- Nothing is summed: two meetings in `meetingUsage` never produce a combined figure, `unattributedCalls` is never added to `calls`, and the office never reads `Meeting.tokensAccumulated` or `Meeting.costAccumulated` (both `@deprecated`: always `0` outside the bundled demo script). If your host reports a mixed-currency meeting, send `cost: null` rather than picking one currency; `UsageFigures` has room for exactly one.
- `formatMeetingUsage(figures, locale, translate)` is exported and returns the same formatted rows the panel uses, if you want to show them elsewhere.
- Your host must send a `meetingId` on its meeting events to key this prop reliably. Without one, the library falls back to `meeting-<event id>`.

### Call details

Per-agent totals answer "who spent what"; `showCallDetails` answers the next question: which calls made up that number. `false` by default, independent of `showUsage` and `showUsageBadges`:

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

<AgentOffice events={events} showCallDetails agentCallDetails={agentCallDetails} onSelectAgent={setSelected} />
```

- Clicking an agent on the canvas, choosing it from the keyboard agent list, or setting `selectedAgentId` opens a panel next to that agent's calls, as reported in `agentCallDetails[agentId]`. A selected id that is not an agent in the current snapshot opens nothing. `onSelectAgent` is unchanged: there is no second callback for the panel.
- The panel never fetches, sums, prices or sorts anything. Every call appears in the order you sent it, with 12 fixed rows: provider, model, status, latency, request id, input tokens, output tokens, cost source and cost always; cache read, cache write and reasoning tokens only when that key is present in `tokens` (a key sent as `null` still shows "unknown"; a real `0` shows `0`; an omitted key shows no row at all, the same rule `showUsage` uses for optional token fields).
- An agent with no entry in `agentCallDetails`, or an empty array, shows "No call details provided", never "0 calls".
- `AgentCallDetail` has no field that can carry a prompt, a completion or any other free text: `provider`, `model` and `requestId` are the only free strings, capped at 128 Unicode code points (longer values are cut with an ellipsis, in the text and in the `title` attribute), and `status`/`costSource` are closed to their known values, anything else reads "unknown". The panel never spreads the row object, so an extra key your code might add by mistake (`prompt`, `content`...) is never rendered.
- Close the panel with the close button or `Escape` (while focus is inside it); both call `onSelectAgent(null)`, same as pressing the selected agent again in the keyboard list.
- The panel is never drawn into a [video export](#video-export): `recordReplay` has no option for it.

### Figures from the Agent Viewer server

When your app is connected to the Agent Viewer server, read `GET /api/v1/usage` (`usageSummary()` in the TypeScript SDK) and pass its figures through. The library still does no math: the host maps each bucket, and only figures that are fully known become numbers.

```tsx
import type { UsageFigures } from '@warlockcode/agent-viewer';
import type { UsageBucket } from './sdk/typescript/index';

/** Exact figures only: a partial sum would be shown as if it were exact, so it becomes null ("unknown"). */
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

- `inputTokens` and `outputTokens` come from `tokens.input.sum` and `tokens.output.sum` only when that kind's `unreportedCount` is `0`; otherwise pass `null`.
- `totalTokens` is the host's own addition of the two, sent only when both pass that test; otherwise `null`.
- `cost` and `currency` are sent only when the bucket has calls, `costUnknownCount` is `0` and `byCurrency` has exactly one entry (one currency, one cost source). Otherwise send `cost: null`, shown as "unknown".
- The `agentId: null` bucket (calls without an agent) has no key in `byAgent`; it only counts in `total`. Failed calls (`failed`) are not part of these figures.

### Feeding `usage` from the server (issue #66)

`GET /api/v1/usage/rollup` ([full reference](integration.md#usage-rollup-get-apiv1usagerollup-issue-66)) answers a sharper question than `GET /api/v1/usage`: a time range, a time basis, and up to 3 grouping dimensions. The TypeScript SDK's `toUsageFigures()` does the same "only an exact figure becomes a number" mapping `toFigures()` does above, already written for a rollup group:

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

`toUsageFigures(group, { costSource })` returns `cost` as a number only when the group has exactly one cost entry, that entry's source matches the `costSource` you asked for, and `unknownCostCalls` is `0`; two currencies, a reported/estimated mix, or any unknown cost all give `cost: null`. `inputTokens`/`outputTokens` are `null` unless every call in the group reported that kind, and `totalTokens` is their sum (cache and reasoning tokens are excluded) only when both are known. This helper runs in your host backend, next to the SDK call: the component still only ever displays the `UsageFigures` you pass it, imported here as a type, never computed by `@warlockcode/agent-viewer` itself.

Per-meeting and per-tool spend (issue #80, `groupBy: ['meeting']`/`['tool']` on the same endpoint) work exactly the same way: `toUsageFigures()` maps one of those groups just like any other, and if a host wants to show a meeting's or a tool's cost in the office, it computes that figure server-side and passes it through its own props, same as the per-agent example above. The library itself has no `meeting`/`tool` concept: it never fetches the rollup, never sums anything, and this item adds no new import or prop to `@warlockcode/agent-viewer`.

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

`parseEventLog(input)` reads a canonical JSONL V1 log, or an OTLP/JSON file (a `string`, `File` or `Blob`, up to `MAX_EVENT_LOG_SIZE_BYTES`, 25 MB) and validates every line. See [event-log.md](event-log.md) for the format, including the OTLP logs/metrics/traces files section.

```tsx
async function loadRun(file: File) {
  const result = await parseEventLog(file);
  if (result.issues.length > 0) console.warn(result.issues);
  return result.events; // sorted by timestamp, ready for useEventReplay
}
```

The result is `{ events, issues, totalLines, format, otlp? }`. Invalid lines are reported in `issues` (`line`, `error`, `raw?`, `code?`, `path?`) without stopping the parse. OTLP logs convert to `llm.usage`/`llm.failed` events; OTLP metrics return no events and one issue explaining they are pre-aggregated counters; OTLP traces are not supported yet and also return no events plus one issue. `otlp` (present whenever `format === "otlp"`) reports which signals were found and the per-record `logRecords`/`converted`/`skipped`/`rejected` counters. The component has no built-in file drop; wire your own file input to `parseEventLog`.

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
- `RecordReplayOptions` has no field for call details: the panel from `showCallDetails`/`agentCallDetails` is never drawn into a video, whatever the page it was captured from shows.

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
- `LLM_ERROR_KINDS` lists the `errorKind` values of `llm.failed` (`rate_limited`, `overloaded`, `timeout`, `invalid_request`, `auth`, `server_error`, `cancelled`, `unknown`), and `isLlmErrorKind(value)` checks one. The type is `LlmErrorKind`.

Contract fields used by the office in this version:

- `agent.message.sent` accepts an optional `kind`, one of `MESSAGE_KINDS`.
- `meeting.message` `type` is one of `MESSAGE_KINDS` (default `statement`).
- `llm.usage` accepts an optional `currency`, an ISO 4217 code of three uppercase letters such as `USD`.
- `llm.usage` reports cache tokens in `cacheReadTokens` (served from the prompt cache) and `cacheWriteTokens` (written to it). Both are part of `inputTokens`. `cachedTokens` is deprecated: it is still accepted and copied into `cacheReadTokens`.
- A counter that was not reported (`cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`, `cachedTokens`) stays absent or `null` after validation, never `0`. `normalizeCanonicalEvent` does not invent `inputTokens` or `outputTokens` either.
- `llm.failed` reports one failed model call attempt with `provider`, `model` and `errorKind`. The office only stores the provider and model from it.

The full contract is in [integration.md](integration.md) and [`canonicalContract.ts`](../src/integrations/canonicalContract.ts).

## API reference

Everything is exported from `@warlockcode/agent-viewer`. The stylesheet is `@warlockcode/agent-viewer/style.css`.

| Area | Values | Types |
|---|---|---|
| Office | `AgentOffice` | `AgentOfficeProps` |
| Office model | `OfficeStore`, `buildOfficeSnapshot` | `AgentProfile`, `OfficeEventInput`, `OfficeMode`, `OfficeSnapshot`, `OfficeStoreOptions` |
| Replay | `useEventReplay`, `ReplayControls` | `EventReplay`, `EventReplayOptions`, `ReplayControlsProps` |
| Usage | `formatUsage`, `formatTokens`, `formatCost`, `formatCostSource`, `formatUsageBadge`, `formatMeetingUsage`, `summarizeUsage` | `OfficeUsage`, `UsageFigures`, `FormattedUsageItem`, `UsageBadge`, `UsageCostSource`, `MeetingUsage`, `MeetingUsageFigures` |
| Call details | none | `AgentCallDetail`, `AgentCallDetails`, `AgentCallTokens`, `AgentCallStatus`, `AgentCallCostSource` |
| Texts | `OFFICE_MESSAGES`, `createOfficeTranslator`, `formatMessage`, `builtInMessages`, `isOfficeMessageKey` | `OfficeMessageKey`, `OfficeMessages`, `OfficeMessageParams`, `OfficeTranslate`, `OfficeTranslatorOptions`, `HostTranslate` |
| Core types | none | `Agent`, `AgentRole`, `AgentStatus`, `AgentMood`, `WorkspaceZone`, `ViewerEvent`, `Task`, `TaskStatus`, `Meeting`, `MeetingMessage` |
| Event contract V1 | `SCHEMA_VERSION`, `CANONICAL_EVENT_TYPES`, `EVENT_TYPE_ALIASES`, `MESSAGE_KINDS`, `isMessageKind`, `LLM_ERROR_KINDS`, `isLlmErrorKind`, `normalizeCanonicalEvent`, `validateCanonicalEvent` | `CanonicalEvent`, `CanonicalEventInput`, `CanonicalEventType`, `LegacyEventType`, `EventSeverity`, `MessageKind`, `LlmErrorKind`, `ValidationIssue`, `ValidationResult` |
| Live stream | `connectEventStream` | `RealtimeConnection`, `RealtimeStatus`, `RealtimeConnectionOptions`, `RealtimeResync`, `RealtimeReplayed` |
| Log files | `parseEventLog`, `MAX_EVENT_LOG_SIZE_BYTES` | `EventLogParseResult`, `EventLogParseIssue`, `EventLogIssueCode`, `EventLogOtlpSummary` |
| Video | `recordReplay`, `computeReplaySchedule`, `isRecordingSupported`, `getSupportedMimeType` | `RecordReplayOptions`, `ReplaySchedule` |

`connectEventStream(baseUrl, onEvent, onStatus?, options?)` opens the stream at `${baseUrl}/api/v1/events/stream`, calls `onEvent` for every valid event and reconnects with backoff, resuming from the last event id. The token never travels in a URL, on any transport (issue #71). Options: `token` (sent in an `Authorization: Bearer` header over a streamed `fetch`, when the browser can stream a `fetch` body; where it cannot, the client instead calls `POST /api/v1/stream-tickets` with the token, before every connect and reconnect, and opens `EventSource` with the single-use ticket it gets back; with a token and no `fetch` at all, the connection stops with status `error` and never makes a network call), `fetch` (the `fetch` used for that stream and for minting tickets, the global one by default), `maxReconnectAttempts` (default unlimited), `initialBackoffMs` (1000), `maxBackoffMs` (15000), `heartbeatTimeoutMs` (35000), `lastEventId` (starts the stream from this cursor, typically `snapshot.lastEventId`) and `onResync` / `onReplayed` (below). `onStatus` receives `connecting`, `connected`, `reconnecting`, `disconnected`, `error`, `closed` or `resyncing`. The returned connection has `close()`, `status()`, `getLastEventId()` and `resyncCount()`.

### Reconnect replay and resync (issue #54)

After a reconnect, the server either replays every event the client missed, in order and exactly once, or tells it so with a `resync` frame; it never sends a partial replay. The wire format and server-side rule are in [integration.md](integration.md#reconnect-replay-and-resync). The helper surfaces both outcomes instead of hiding them:

- `onResync?: (info: RealtimeResync) => string | null | undefined | Promise<...>` is called when the server could not replay everything missed. `info.reason` is `cursor_unknown`, `gap_too_large` or `buffer_overflow`; `info.missed` is the number of events the client never saw, or `null` when the server itself does not know (an unknown cursor: never treat `null` as `0`). Reload your state (typically `GET /api/v1/snapshot`) and return the cursor to resume from, usually `snapshot.lastEventId`; returning `null` or `undefined` resumes live only. Throwing or rejecting reconnects with the existing backoff and calls `onResync` again on the next resync, leaving the cursor unchanged. Consecutive resyncs with nothing received in between also wait for the backoff delay, so a server stuck resyncing cannot cause a tight reconnect loop.
- `onReplayed?: (info: RealtimeReplayed) => void` is called after a reconnect replay completes, including one that replayed `0` events. `info.replayed` is the frame count and `info.lastEventId` the id of the last one (`null` when `replayed` is `0`).
- Without `onResync`, a resync still reports the `resyncing` status and increments `resyncCount()`, then reconnects live only: the host learns about the gap even without reloading a snapshot.

Host pattern: load the snapshot once, start the stream from its cursor, and reload the same way on a resync. `snapshot.events` carries only the newest 100 events (it rebuilds the office, never the totals), and usage figures must come from the snapshot's own aggregates (`totalTokens`, `totalCost`), never from re-adding those 100 events:

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

`snapshot.totalCost` and `agents[].cost` currently count a missing cost as `0` on the server (tracked separately); do not present them to a user as a certain figure.

## Isolation guarantees

- Two offices on the same page never share state: each `<AgentOffice>` owns its store.
- Nothing is read from or written to `localStorage` or any other browser storage.
- No usage figure is ever stored: `usage`, `meetingUsage` and `agentCallDetails` are read on each render and never copied into the store, `localStorage` or any other persistence; closing and reopening the office with the same props draws the same figures, nothing cached in between.
- The usage badge, the per-agent panel and the call detail panel render nothing unless the host opts in with `showUsage`, `showUsageBadges` or `showCallDetails`: the props can carry every figure filled in and still produce no visible usage UI while these are `false`.
- No timer invents data. The office checks every 250 ms whether walks finished and meetings can start; only `mode="showcase"` adds simulated activity, and it is marked as simulated.
- No global keyboard shortcuts.
- Nothing runs on import, and no styles are injected.
- In frameworks with server components, render `<AgentOffice>` from a client component (for example with `'use client'` in Next.js), because it uses hooks and a canvas.

The demo app of this repository (`npm run dev`) is built separately with `npm run build`. The library is built with `npm run build:lib` into `dist-lib/`.

## Versioning

The library follows [Semantic Versioning](https://semver.org/). While it is at 0.x, the API may still change: a minor release (0.3.0, 0.4.0...) can include breaking changes, and they are listed in the [CHANGELOG](../CHANGELOG.md). A range such as `^0.2.0` accepts only 0.2.x patch releases.

0.5.0 adds `showUsageBadges`, `showCallDetails`, `meetingUsage` and their types (`UsageBadge`, `UsageCostSource`, `AgentCallDetail`, `AgentCallDetails`, `AgentCallTokens`, `AgentCallStatus`, `AgentCallCostSource`, `MeetingUsage`, `MeetingUsageFigures`). Every one of them is additive and off by default: an app written against 0.2.x keeps working unchanged.
