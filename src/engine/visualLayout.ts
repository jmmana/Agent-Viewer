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
export function isSpeechActive(speech: { text: string; expiresAt: number } | null, nowMs: number): boolean {
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
