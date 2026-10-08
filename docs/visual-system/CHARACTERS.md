# Office Crew — Character Production Catalog

This is the character bible for the six **original** Agent Viewer roles. Source: Agent Viewer visual design guide. All sprites share one base silhouette and perspective; never generate each role as if it belonged to a separate art style.

## Shared requirements

- All characters wear glasses and office or business-casual clothing; no visors or backpacks.
- Readable compact capsule body, short visible legs, small expressive hands.
- Exactly four baseline facing directions: front, back, left, right.
- Distinguish roles using palette, clothing, glasses, accessory, posture and designated workspace.
- The runtime may render status icons/speech bubbles independently of the body frames.
- Required expression set: neutral, focused, happy, thinking, worried, confused, explaining, approving, blocked.

## Role specifications

### CEO — director / orchestrator
- Navy-blue blazer with optional gentle gold trim, formal shirt, narrow rectangular glasses and ID badge.
- Primary prop: executive tablet or corporate phone.
- Pose: upright, relaxed authority; deliberate walking rhythm.
- Expressions: calm, analysis, approval, firm decision, active listening.
- Unique gestures: review tablet, approve with a hand gesture, indicate a dashboard, initiate call.
- Office: `boss_office` (Director Suite).

### Planner — plans / delegation
- Purple and blue jacket, round glasses, professional trousers.
- Prop: clipboard, planning tablet or notebook.
- Body language: animated but disciplined; fast, purposeful walks.
- Unique gestures: show a plan, point to board, delegate and propose.
- Office: `leads_area` (Architecture & Leads).

### Developer — implementation / tools
- Blue/cyan tech jacket or refined hoodie, rectangular glasses, casual-smart shoes.
- Prop: laptop, optional headphones.
- Body language: forward focus.
- Unique gestures: type, debug, show terminal/tool badge, celebrate completion, scratch head for blocked.
- Office: `development`.

### Analyst — research / data
- Green/teal layers, larger glasses, professional shirt.
- Prop: tablet/dashboard, folder or laptop.
- Body language: curious, precise and observant.
- Unique gestures: review charts, indicate trend, compare sources, present findings.
- Office: `research` or existing workspace of the event.

### Reviewer — QA / approvals
- Orange/muted terracotta formal jacket, slender glasses and identification card.
- Prop: review tablet/clipboard and annotation pen.
- Body language: meticulous and attentive.
- Unique gestures: annotate, point out issue, object, approve, cross arms when blocked.
- Office: `qa_lab` or current review zone from an event.

### Finance — cost / budget
- Dark-green jacket or waistcoat, charcoal trousers, classic rectangular glasses.
- Prop: figures tablet, digital calculator or cost report.
- Body language: formal, detail-oriented.
- Unique gestures: evaluate costs, flag risk, approve budget and report figures.
- Office: whichever actual workspace/event assigns, not an invented finance room.

## CEO pilot production steps

1. Concept reference: front, both profiles, back; nine baseline expressions; walking thumbnails; office gestures.
2. Produce **one approved neutral front pose** as a stand-alone transparent export.
3. Derive matching back/left/right views against the *same model sheet*, not independent interpretations.
4. Draw a frame-accurate walk cycle for each direction.
5. Add phone, approval, tablet, meeting and idle clips.
6. Confirm alignment, floor anchor and runtime legibility before reproducing the rig across remaining five roles.

**Current status:** `ceo/idle-front.svg` is an **engineering prototype**, not a fully approved high-resolution character sprite. The first concept sheet is a reference illustration, not an animation file.
