# Agent Viewer Living Office Specification

Status: Draft v1  
Language: English is canonical. Locale packs may translate labels and presentation content without changing semantic IDs.

## 1. Product definition

Agent Viewer is a humanized visual observability framework for multi-agent systems. It converts runtime events into a living office where users can see agents work, move, collaborate, wait, meet, socialize, and consume model resources.

The renderer must never require private chain-of-thought. It visualizes observable state, explicit messages, tool activity, tasks, meetings, provider/model usage, and user-approved ambient simulation.

## 2. Runtime authority vs presentation

Two layers are intentionally separate:

1. **Operational state** — authoritative data received from the connected runtime or local demo engine.
2. **Presentation state** — walking interpolation, gestures, temporary mood, ambient chatter, bubble placement, animation and camera effects.

Presentation behavior must not silently overwrite authoritative work state.

## 3. Canonical agent states

Core work states:

- OFFLINE
- IDLE
- AVAILABLE
- THINKING
- READING
- RESEARCHING
- CODING
- WRITING
- TESTING
- USING_TOOL
- WAITING
- WAITING_APPROVAL
- BLOCKED
- DELEGATING
- REVIEWING
- DELIVERING
- DONE
- ERROR

Collaboration/presentation states:

- PHONE_CALL
- WALKING
- IN_MEETING
- COFFEE_BREAK
- CHATTING

A future implementation may separate operational state from activity state so that, for example, an agent remains operationally WAITING while visually walking to the café.

## 4. Room semantics

| Room | Semantic purpose |
|---|---|
| Director Suite | Orchestration, escalation, executive decisions, emergency meeting fallback |
| Meeting Room A | Primary collaborative meeting room |
| Meeting Room B | Overflow collaborative meeting room |
| Architecture & Leads | Planning, delegation, architecture and technical review |
| Engineering | Coding, implementation and tool execution |
| QA Lab | Testing, validation and quality review |
| Research Library | Research, RAG, document analysis and knowledge work |
| Espresso / Social Area | Idle social activity, jokes, informal conversation and waiting |
| Model Ops | Provider/model/token/cost/latency observability |

Room display names are localized. Room IDs are stable API values.

## 5. State-to-destination policy

Default rules:

- CODING / WRITING / USING_TOOL → Engineering unless the event specifies another workspace.
- TESTING → QA Lab.
- RESEARCHING / READING → Research Library.
- DELEGATING / architecture review → Architecture & Leads.
- IN_MEETING → reserved meeting room.
- IDLE beyond the configured grace period → eligible for Espresso / Social Area.
- OFFLINE → hidden, dimmed, or placed at the configured offline location.
- ERROR / BLOCKED → remain at current work location unless an explicit escalation event moves the agent.

Explicit external workspace instructions take precedence over ambient routing.

## 6. Meeting choreography

The preferred humanized collaboration sequence is:

1. A meeting is requested.
2. Initiator enters PHONE_CALL presentation state.
3. Invitees receive a short visible call/message.
4. Scheduler reserves Meeting Room A.
5. If unavailable, reserve Meeting Room B.
6. If both are unavailable, reserve Director Suite if policy allows it.
7. Participants enter WALKING presentation state.
8. Meeting begins only when required participants have arrived or timeout policy allows partial start.
9. Dialogue and decisions appear as observable meeting events.
10. Meeting ends.
11. Reservation is released.
12. Participants route according to their next operational state.

No room may host incompatible overlapping reservations.

## 7. Idle social life

After an idle grace period, agents may engage in optional ambient behavior:

- drink coffee
- tell jokes
- discuss sports, technology, entertainment or general current events
- react with lightweight moods
- join or leave a small conversation group

Ambient text is presentation content and must be visibly distinguishable from runtime-supplied messages.

Suggested moods:

- neutral
- happy
- amused
- excited
- surprised
- focused
- annoyed
- frustrated
- tired

Mood is visual metadata only.

## 8. Model Ops room

The Model Ops room retains server/NOC aesthetics but its primary purpose is LLM telemetry.

Provider aggregation:

- provider
- models
- active requests
- request count
- input tokens
- output tokens
- cached tokens
- total tokens
- latency
- errors/timeouts
- cost and cost provenance

Model aggregation:

- provider
- model
- requests
- tokens
- cost
- currently associated agents

Cost must distinguish:

- provider-reported cost
- locally estimated cost
- unknown cost

Unknown must never be rendered as zero.

## 9. Readability contract

Room labels use a reserved safe zone. Static furniture must not overlap the header region. Dialogue, labels and operational overlays must use bounded placement and collision avoidance.

Dialogue visual classes:

- operational
- phone call
- meeting
- ambient/social
- warning/error

The same semantic information must remain available when animations are disabled.

## 10. Internationalization

English is the source locale. Spanish is the initial secondary locale.

Semantic IDs, event names, state names and provider/model identifiers are never translated. Human-facing labels, tooltips, room names and ambient content are translated through locale keys.

Fallback locale: English.
