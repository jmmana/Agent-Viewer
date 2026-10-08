export interface OverlayRect { x: number; y: number; width: number; height: number }

export function cameraCenter(width: number, height: number) {
  return { x: width / 2, y: height / 2 - 24 };
}

export function overlapArea(a: OverlayRect, b: OverlayRect, gap = 6): number {
  return Math.max(0, Math.min(a.x + a.width + gap, b.x + b.width) - Math.max(a.x - gap, b.x)) *
    Math.max(0, Math.min(a.y + a.height + gap, b.y + b.height) - Math.max(a.y - gap, b.y));
}

/** Choose the nearest free screen-space slot, staying inside the visible canvas. */
export function placeOverlay(preferred: OverlayRect, occupied: readonly OverlayRect[], viewport: { width: number; height: number }): OverlayRect {
  const padding = 8;
  const width = Math.min(preferred.width, Math.max(1, viewport.width - padding * 2));
  const height = Math.min(preferred.height, Math.max(1, viewport.height - padding * 2));
  let best: OverlayRect = { ...preferred, width, height };
  let bestScore = Infinity;
  for (const row of [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6, -7, 7]) {
    for (const column of [0, -1, 1, -2, 2]) {
      const x = Math.max(padding, Math.min(preferred.x + column * (width + 8), viewport.width - width - padding));
      const y = Math.max(padding, Math.min(preferred.y - row * (height + 8), viewport.height - height - 64));
      const candidate = { x, y, width, height };
      const overlap = occupied.reduce((area, rect) => area + overlapArea(candidate, rect), 0);
      const score = overlap * 10000 + Math.hypot(x - preferred.x, y - preferred.y);
      if (score < bestScore) { best = candidate; bestScore = score; }
    }
  }
  return best;
}

/** Wall-clock expiry matches the Date.now() timestamps supplied by the event layer. */
export function isSpeechActive(speech: { text: string; expiresAt: number } | null | undefined, nowMs: number): boolean {
  return !!speech && !!speech.text.trim() && speech.expiresAt > nowMs;
}

export function wrapText(text: string, maxWidth: number, measure: (text: string) => number, maxLines = 2): string[] {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let line = '';
  // Split long words (URLs, tool names) too, so they cannot escape the card.
  for (const word of words) {
    if (measure(word) <= maxWidth) {
      const candidate = line ? line + ' ' + word : word;
      if (line && measure(candidate) > maxWidth) { lines.push(line); line = word; }
      else line = candidate;
    } else {
      if (line) { lines.push(line); line = ''; }
      for (const char of word) {
        if (line && measure(line + char) > maxWidth) { lines.push(line); line = ''; }
        line += char;
      }
    }
  }
  if (line.trim()) lines.push(line.trim());
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let last = lines[maxLines - 1];
    while (last && measure(last + '…') > maxWidth) last = last.slice(0, -1);
    lines[maxLines - 1] = last.trimEnd() + '…';
  }
  return lines.length ? lines : [''];
}

const NAME_ARROW = ' → ';

/** Cuts `text` to `maxWidth`, ending with an ellipsis when something was removed. */
export function ellipsize(text: string, maxWidth: number, measure: (text: string) => number): string {
  if (measure(text) <= maxWidth) return text;
  let out = text;
  while (out && measure(out + '…') > maxWidth) out = out.slice(0, -1);
  return out.trimEnd() + '…';
}

/**
 * Fits "speaker → target" into the header of a speech bubble. Long names are shortened fairly: first both keep
 * only their first two words, then both are cut with an ellipsis, sharing the width so the target is never
 * the only one cut.
 */
export function fitBubbleNames(
  speaker: string,
  target: string | undefined,
  maxWidth: number,
  measure: (text: string) => number,
): string {
  const from = speaker.trim();
  const to = target?.trim() || undefined;
  const join = (a: string, b?: string) => (b ? a + NAME_ARROW + b : a);
  const full = join(from, to);
  if (measure(full) <= maxWidth) return full;

  const twoWords = (name: string) => name.split(/\s+/).slice(0, 2).join(' ');
  const shortFrom = twoWords(from);
  const shortTo = to ? twoWords(to) : undefined;
  const short = join(shortFrom, shortTo);
  if (measure(short) <= maxWidth) return short;
  if (!shortTo) return ellipsize(shortFrom, maxWidth, measure);

  const available = Math.max(0, maxWidth - measure(NAME_ARROW));
  const fromWidth = measure(shortFrom);
  const toWidth = measure(shortTo);
  let fromMax = available / 2;
  let toMax = available / 2;
  // A name shorter than its half gives the rest of its space to the other one.
  if (fromWidth < fromMax) toMax = available - fromWidth;
  else if (toWidth < toMax) fromMax = available - toWidth;
  return ellipsize(shortFrom, fromMax, measure) + NAME_ARROW + ellipsize(shortTo, toMax, measure);
}

/** How long a speech bubble takes to leave, in milliseconds. */
export const BUBBLE_EXIT_MS = 220;

/**
 * Exit animation of a speech bubble. The card and its text stay fully opaque (a translucent card would let the
 * office show through the text); the bubble shrinks and drops toward its agent while only the outline and the
 * pointer fade.
 */
export function bubbleExitStyle(remainingMs: number, reducedMotion = false): {
  scale: number;
  offsetY: number;
  cardAlpha: number;
  outlineAlpha: number;
} {
  if (reducedMotion) return { scale: 1, offsetY: 0, cardAlpha: 1, outlineAlpha: 1 };
  const progress = Math.min(1, Math.max(0, 1 - remainingMs / BUBBLE_EXIT_MS));
  const eased = progress * progress;
  return { scale: 1 - 0.35 * eased, offsetY: 10 * eased, cardAlpha: 1, outlineAlpha: 1 - progress };
}
