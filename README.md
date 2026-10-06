<p align="center">
  <img src="docs/assets/agent-viewer-banner.svg" width="100%" alt="Agent Viewer — Watch your AI agents work. Visual agent observability in a living virtual office." />
</p>

<p align="center">
  <strong>Watch your AI agents work.</strong><br />
  A living virtual office for agent activity, collaboration, tokens and costs.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-in_development-a855f7?style=flat-square" alt="In development" />
  <img src="https://img.shields.io/badge/vision-free_%26_open_source-22c55e?style=flat-square" alt="Free and open-source vision" />
  <img src="https://img.shields.io/badge/interface-animated_office-06b6d4?style=flat-square" alt="Animated office interface" />
  <a href="https://github.com/jmmana/Agent-Viewer/stargazers"><img src="https://img.shields.io/github/stars/jmmana/Agent-Viewer?style=flat-square&color=a855f7" alt="GitHub stars" /></a>
</p>

<p align="center">
  <a href="#preview">Preview</a> ·
  <a href="#the-idea">The idea</a> ·
  <a href="#what-you-can-explore-today">Features</a> ·
  <a href="#run-locally">Run locally</a> ·
  <a href="#project-status-and-roadmap">Roadmap</a> ·
  <a href="#integration-direction">Integrate</a> ·
  <a href="#contribute">Contribute</a> ·
  <a href="README.es.md">Español</a>
</p>

## The idea

**Agent Viewer turns agent activity into a workplace you can understand at a glance.** A director coordinates leaders; leaders delegate to analysts; agents work at their desks, exchange messages and gather in meeting rooms. Alongside the office, an inspector explains who is doing what, which model is involved, and how many tokens and dollars the work consumes.

The goal is a modern, expressive office with animated characters, readable conversations and purposeful movement. Every operational action should be tied to an agent event, so you can follow the actual work as well as its visual representation.

**Built to be free, downloadable and community driven.** The aim is to make agent collaboration easier to understand and share.

### The living-office direction

Agent Viewer is evolving from a static office demo into a **humanized agent observability framework**:

- Agents move to the room that matches their operational state.
- Idle agents can walk to the espresso/social area, tell jokes and hold clearly marked ambient conversations.
- Collaboration can begin with a visible phone call, continue in a reserved meeting room and fall back to the Director Suite when meeting rooms are occupied.
- The former passive infrastructure area becomes **Model Ops**, combining server-room aesthetics with live provider/model/token/cost telemetry.
- English is the canonical interface language, with locale packs starting with English and Spanish.
- External runtimes remain authoritative; Agent Viewer visualizes observable events rather than requiring private reasoning.

The detailed behavior contract lives in [`docs/specs/living-office.md`](docs/specs/living-office.md).

## Preview

![Agent Viewer current Canvas rendering: furnished office, character poses and meeting speech cards](docs/assets/office-current.png)

*Snapshot generated directly from the current Canvas renderer during a scripted meeting. It shows the office scene, not the surrounding application panels. Conversations and activity belong to the local simulation.*

<details>
<summary><strong>Earlier interface references and the nine-area layout</strong></summary>

<br />

![Earlier Agent Viewer interface reference](docs/assets/office-preview.png)

![Agent Viewer office layout: director, boardroom, infrastructure, leads, engineering, QA, research, cafeteria and lounge](docs/assets/office-layout.png)

</details>

## What you can explore today

The React application and local simulation are now included in this repository.

| Feature | Available behavior |
|---|---|
| **Animated office** | Nine furnished areas, seven characters, walking, working poses, speaking gestures and subtle environmental animation. |
| **Camera** | Pan, zoom, four-way rotation, fit the full office and focus on a selected agent. |
| **Conversations** | Temporary speech cards, readable names and states, collision-aware placement and animated links for messages with a named recipient. |
| **Meetings** | Scripted and event-driven collaboration with Meeting Rooms A/B, Director Suite fallback and an elastic hidden collaboration floor when visible rooms are full. |
| **Tasks** | A task board, scripted handoffs and custom task dispatch into the local simulation. |
| **Agent inspector** | Role, configured provider/model, current state, recent events and simulated usage. |
| **Timeline** | Event history, category filters, step-by-step demo controls and playback at 1×, 2× or 5×. |
| **Usage and export** | Token/cost telemetry, live Model Ops aggregation, configurable price entries and JSON session export. |

**Current mode: local simulation plus optional external event ingestion.** The built-in demo still generates its own activity, but the repository now also includes a lightweight REST/SSE ingestion service, TypeScript and Python client examples, external agent registration, status/message events and LLM-usage telemetry. No model API key is required to explore the local office.

### Making the office feel alive

- Warm floor lamps, larger desks and a larger boardroom table, contact shadows and subtle room lighting.
- Softer floor materials and room plaques that make each space easier to recognize.
- Character blinking, walking cycles, typing poses, meeting seats and gestures while a message is visible.
- Screen-space labels that retain their size as you zoom; a compact overview hides inactive labels at distant zoom levels.
- Wall-clock message expiry, so old dialogue disappears correctly.
- Time-based movement that stays consistent across refresh rates without changing the event state during drawing.
- A reduced-motion preference that suppresses ambient cycles and snaps travel to its destination.

### An office with a purpose

| Area | Role in the experience |
|---|---|
| **Executive Director Suite** | Coordination, priorities and escalations. |
| **Meeting Room A** | Primary team meetings, decisions and collaborative reviews. |
| **Meeting Room B** | Overflow collaboration when Room A is occupied; planned in the living-office scheduler. |
| **Model Ops / Token Operations Center** | Provider/model activity, tokens, cost, latency and request telemetry inside a server/NOC-style room. |
| **Architecture & Leads** | Planning, technical reviews and delegation. |
| **Engineering & Dev Pods** | Implementation and tool execution. |
| **QA & Test Automation Lab** | Validation, test results and feedback. |
| **Research Archives & Library** | Research, document analysis and knowledge gathering. |
| **Cafeteria / Espresso Bar** | Idle social behavior, coffee, jokes and clearly marked ambient conversations. |
| **Team Lounge** | Team interaction and a quieter shared space. |

Room design should make these roles recognizable through desks, computers, chairs, plants, shelves and presentation screens. Labels and dialogue bubbles should remain readable while the office is panned, rotated or zoomed.

## Run locally

Use **Node.js 24** and npm. Clone the repository and install the locked dependencies:

```bash
git clone https://github.com/jmmana/Agent-Viewer.git
cd Agent-Viewer
npm ci
npm run dev
```

Open **http://localhost:3000** and press the green play button to start the scripted scenario. You can also advance one event at a time, change playback speed, select an agent and inspect the meeting or task views.

If your environment restricts network interface discovery, bind Vite to localhost:

```bash
npm run dev -- --host=127.0.0.1
```

### Controls

| Action | Control |
|---|---|
| Play / pause the sequence | Play button or **Space** |
| Advance one event | Step button while paused |
| Reset the session | Reset button in the top bar |
| Pan the office | Drag the canvas |
| Zoom | Mouse wheel or zoom buttons |
| Rotate / fit the office | Camera buttons below the office |
| Inspect an agent | Click its character or select it in the sidebar |
| Office / tasks / meetings | **O** / **T** / **M** |
| Clear selection / close dialogs | **Esc** |

At small window sizes the sidebar starts closed so the office keeps its available width. Open it with **Ver Timeline**. To request less animation, enable your operating system's reduced-motion preference.

### Checks and production build

```bash
npm test
npm run lint
npm run build
npm run preview
```

The regression tests cover movement at different refresh rates, reset and arrival behavior, reduced motion, message expiry, crowded card placement and text wrapping. The build writes the application to `dist/`. Preview serves that build locally; it does not publish the application.

## Architecture today

| Layer | Implementation |
|---|---|
| Application | React 19 + TypeScript |
| UI styling | Tailwind CSS 4 + Lucide icons |
| Development and bundling | Vite 8 |
| Office rendering | Native Canvas 2D with a rectangular 2.5D layout |
| Simulation and events | In-memory TypeScript engine with scripted scenarios plus a versioned external event ingestion path |
| Character movement | A presentation-only motion cache, separate from simulation state |
| Labels and dialogue | A screen-space layout pass with bounded cards and collision avoidance |
| Sounds | Synthesized Web Audio effects |

### Source map

| File | Purpose |
|---|---|
| `src/App.tsx` | Application state, navigation and playback controls. |
| `src/components/OfficeCanvas.tsx` | Render loop, camera, selection and pointer interaction. |
| `src/engine/canvasRenderer.ts` | Floors, rooms, furniture, characters and dialogue. |
| `src/engine/officeModel.ts` | Office layout, furniture and initial agent configuration. |
| `src/engine/visualMotion.ts` | Time-based presentation positions without mutating supplied agents. |
| `src/engine/visualLayout.ts` | Camera center, card placement, message expiry and text wrapping. |
| `src/engine/simulationEngine.ts` | Scripted tasks, meetings, events and simulated usage. |
| `src/engine/livingOfficeEngine.ts` | Agent routing, room reservations, coffee seating, social activity and elastic overflow meetings. |
| `src/engine/modelOps.ts` | Provider/model token and cost aggregation for Model Ops. |
| `server/index.ts` | Lightweight REST + SSE event ingestion service. |
| `sdk/typescript/index.ts` | TypeScript client SDK example. |
| `sdk/python/agent_viewer.py` | Python client SDK example. |
| `src/types/agent.ts` | Agent, task, meeting, tool, event and pricing types. |
| `tests/office-visuals.test.mjs` | Focused regressions for motion and dialogue layout. |

## Integration direction

The repository now includes a first public ingestion path for versioned observable events from existing agent runtimes. A lightweight service accepts events over REST and broadcasts them to the browser over SSE; the external runtime remains authoritative.

Adapters should map task assignments, messages, meetings, tool calls and provider-reported usage into the versioned event model. See [`docs/integration.md`](docs/integration.md), [`sdk/typescript`](sdk/typescript) and [`sdk/python`](sdk/python) for the current contract and examples.

Current event types include `agent.registered`, `agent.status.changed`, `task.assigned`, `message.sent`, meeting lifecycle events, tool lifecycle events and `llm.usage`. The ingestion API is still early-stage, but it is now implemented and versioned as part of the repository.

Real integrations must distinguish provider-reported usage from estimates, unknown values from zero and displayable messages from internal model reasoning. The current service supports optional bearer authentication and SSE; durable server-side persistence and production-grade provider adapters remain future work.

## Project status and roadmap

- [x] Publish application source and reproducible npm setup.
- [x] Build a nine-area office with seven configured characters.
- [x] Add the local task, meeting and timeline simulation.
- [x] Improve room atmosphere, character gestures and readable dialogue cards.
- [x] Add motion and dialogue regression tests.
- [x] Implement the first public REST/SSE ingestion path and SDK examples.
- [x] Add autonomous room routing, phone-call choreography and Meeting Room B.
- [x] Add an elastic hidden collaboration floor when visible rooms are full.
- [x] Add humanized idle social behavior and locale-aware conversation packs.
- [x] Add live Model Ops provider/model token and cost aggregation.
- [ ] Complete English/Spanish UI migration across every secondary view.
- [ ] Persist sessions and replay recorded agent runs.
- [ ] Add downloadable packaged releases.
- [x] Add an open-source license and contribution/security guidelines.

You can run the source locally today. Packaged installers are not yet available. External ingestion is available for development/testing, but production integrations should still validate authentication, deployment and data-handling requirements. [Star the project](https://github.com/jmmana/Agent-Viewer/stargazers) or use **Watch → Custom → Releases** to follow future downloads.

## Contribute

Interested in office animation, character design, agent integrations or observability?

- [Open an issue](https://github.com/jmmana/Agent-Viewer/issues/new) with a focused proposal, use case or visual improvement.
- For interface feedback, include a screenshot and describe the expected behavior.
- For an adapter proposal, explain which runtime emits the events and which usage fields it exposes.
- For code contributions, coordinate the scope in an issue before starting.

For code changes, run `npm test`, `npm run lint` and `npm run build`. Include screenshots for office changes and keep simulated activity clearly identified until a real adapter is connected.

## License

Agent Viewer is released under the [MIT License](LICENSE).

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution workflow and [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Author

Created by **[Juan Manuel Castillo Pinto](https://github.com/jmmana)** · **WarlockCode**

[LinkedIn](https://linkedin.com/in/jmmana) · [Portfolio](https://juancastillo.bio)

## Languages

English is the canonical source language. Spanish documentation is available in [`README.es.md`](README.es.md). The application now includes the localization foundation and persists the selected locale; remaining component migration is tracked in issue AV-006.
