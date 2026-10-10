# Crew audio: origin and license of every sound (#150)

Crew's audio engine (`src/crew/crewAudioEngine.ts`) is independent from the Cartoon
mode sound effects (`src/engine/soundEffects.ts`): separate code, separate state,
separate user preference. This document lists every sound the Crew engine can
produce, where it came from and under what license, per the acceptance criteria of
issue [#150](https://github.com/jmmana/Agent-Viewer/issues/150).

The canonical, machine-readable version of this table lives in
`src/crew/crewAudioAssets.ts` (`CREW_AUDIO_MANIFEST`). Keep both in sync: a new
sound needs an entry in both places before it ships.

## Sounds

| id | kind | where it is used | origin | license |
|---|---|---|---|---|
| `lounge-ambient` | music (loop) | Lounge room background music | Synthesized at runtime by the Crew engine with Web Audio API oscillators (a four-note soft arpeggio, `LOUNGE_NOTES_HZ` in `crewAudioEngine.ts`). No recorded sample, no external audio file. | CC0 / public domain. Original code written for this repository; no third-party IP. |
| `ui-notification` | cue (one-shot) | Generic visual+sound feedback, reusable by any room | Synthesized at runtime: a single sine oscillator with a short gain envelope. No recorded sample, no external audio file. | CC0 / public domain. Original code written for this repository; no third-party IP. |

## Why synthesized sounds, not audio files

Every sound is generated in the browser from oscillators and gain envelopes,
exactly like the existing Cartoon mode effects in `src/engine/soundEffects.ts`.
There is no `.mp3`/`.wav`/`.ogg` file to license, attribute or track for broken
links: the "asset" is the TypeScript code itself, written for this repository.
This sidesteps any third-party IP risk entirely, at the cost of simpler, less
produced sound than a recorded track would give.

## What is a placeholder, and what is scoped out

- Both sounds above are explicit **placeholders**: issue #150 does not define
  Crew's final audio art direction. A future issue can replace either one with a
  licensed or commissioned track; when it does, update this table and the
  manifest with that asset's real, verifiable license.
- The phone ring (issue #145) and the coffee sound (issue #146) are **separate
  issues** and are deliberately **not wired to any room by this change**. The
  engine already has the primitives (`playCue`, per-room `CREW_ROOM_MUSIC`) that
  those issues can reuse; nothing here should need to change for them to add
  their own cue and map it to their own room.
- Only the Lounge room has background music today (`CREW_ROOM_MUSIC.lounge` in
  `src/crew/crewAudioAssets.ts`). Every other room maps to `null` (silence) on
  purpose, so Lounge music can never play by accident in another room (QA, the
  CEO office, etc.).

## Behavioral guarantees this document assumes

These are enforced by `CrewAudioEngine` and `useCrewAudio` (see their unit tests
in `tests/lib/crewAudioEngine.test.ts` and `tests/lib/useCrewAudio.test.tsx`), not
just described here:

- Music is off by default and never starts without an explicit user gesture
  (the Play button in `CrewStage`'s audio panel). Leaving a room with music and
  coming back never auto-resumes it; the user presses Play again.
- Changing rooms fades the previous track out instead of cutting it abruptly.
- Losing window/tab focus pauses playback; regaining focus resumes only if
  playback was already authorized before the focus loss (not a new autoplay).
- Unmounting `CrewStage` (including switching to Cartoon mode) disposes the
  engine: every oscillator is stopped, every node is disconnected, and the
  `AudioContext` is closed. No listener or node survives the component.
- A browser blocking autoplay (`AudioContext.resume()` rejecting) is caught and
  surfaced as a `blocked` state with its own caption, never thrown or silently
  retried.
