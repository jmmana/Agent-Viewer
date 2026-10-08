/**
 * Edits JSON text in place, keeping every byte that is not part of the edit: the user's own spacing, line
 * breaks and key order survive an install, and an uninstall that removes what install appended gives back the
 * original text. Used for `.claude/settings.local.json`.
 */

export type JsonNode =
  | { kind: 'object'; start: number; end: number; members: JsonMember[] }
  | { kind: 'array'; start: number; end: number; items: JsonNode[] }
  | { kind: 'scalar'; start: number; end: number };

export interface JsonMember {
  key: string;
  keyStart: number;
  value: JsonNode;
}

class JsonTextError extends Error {}

/** Parses JSON text into a tree of spans (`start` inclusive, `end` exclusive). Throws on invalid JSON. */
export function parseJsonSpans(text: string): JsonNode {
  let pos = 0;
  const ws = () => {
    while (pos < text.length && /[ \t\n\r]/.test(text[pos])) pos++;
  };
  const fail = (): never => {
    throw new JsonTextError(`Unexpected character at position ${pos}`);
  };
  const string = (): string => {
    const start = pos;
    if (text[pos] !== '"') fail();
    pos++;
    while (pos < text.length && text[pos] !== '"') {
      if (text[pos] === '\\') pos++;
      pos++;
    }
    if (text[pos] !== '"') fail();
    pos++;
    return JSON.parse(text.slice(start, pos)) as string;
  };
  const value = (): JsonNode => {
    ws();
    const start = pos;
    const ch = text[pos];
    if (ch === '{') {
      pos++;
      const members: JsonMember[] = [];
      ws();
      if (text[pos] === '}') {
        pos++;
        return { kind: 'object', start, end: pos, members };
      }
      for (;;) {
        ws();
        const keyStart = pos;
        const key = string();
        ws();
        if (text[pos] !== ':') fail();
        pos++;
        members.push({ key, keyStart, value: value() });
        ws();
        if (text[pos] === ',') { pos++; continue; }
        if (text[pos] === '}') { pos++; break; }
        fail();
      }
      return { kind: 'object', start, end: pos, members };
    }
    if (ch === '[') {
      pos++;
      const items: JsonNode[] = [];
      ws();
      if (text[pos] === ']') {
        pos++;
        return { kind: 'array', start, end: pos, items };
      }
      for (;;) {
        items.push(value());
        ws();
        if (text[pos] === ',') { pos++; continue; }
        if (text[pos] === ']') { pos++; break; }
        fail();
      }
      return { kind: 'array', start, end: pos, items };
    }
    if (ch === '"') {
      string();
      return { kind: 'scalar', start, end: pos };
    }
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(pos));
    if (!literal) fail();
    pos += literal![0].length;
    return { kind: 'scalar', start, end: pos };
  };
  const root = value();
  ws();
  if (pos !== text.length) fail();
  return root;
}

/** Leading whitespace of the line that holds `pos`. */
export function lineIndent(text: string, pos: number): string {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

/** Indentation unit of the file (two spaces when it cannot tell). */
export function indentUnit(text: string): string {
  const match = /\n([ \t]+)\S/.exec(text);
  if (!match) return '  ';
  return match[1].startsWith('\t') ? '\t' : ' '.repeat(Math.min(match[1].length, 8));
}

/** A value written at a given indentation, in the file's own indentation unit. */
export function formatValue(value: unknown, baseIndent: string, unit: string): string {
  return JSON.stringify(value, null, unit).replace(/\n/g, `\n${baseIndent}`);
}

type Element = { start: number; node: JsonNode };

function elementsOf(node: JsonNode): Element[] {
  if (node.kind === 'object') return node.members.map((member) => ({ start: member.keyStart, node: member.value }));
  if (node.kind === 'array') return node.items.map((item) => ({ start: item.start, node: item }));
  return [];
}

/**
 * Rebuilds a container keeping only some of its elements. `renderElement` returns the new text of a kept
 * element's value. Removing an element also removes the separator that went with it, so dropping the
 * elements an earlier append added restores the original bytes. A container left empty becomes `{}` or `[]`.
 */
export function renderFiltered(
  text: string,
  node: JsonNode & { kind: 'object' | 'array' },
  keep: (index: number) => boolean,
  renderElement: (index: number) => string,
): string {
  const elements = elementsOf(node);
  const open = text[node.start];
  const close = text[node.end - 1];
  const kept = elements.map((_, index) => index).filter(keep);
  if (kept.length === 0) return elements.length === 0 ? text.slice(node.start, node.end) : `${open}${close}`;
  let out = open + text.slice(node.start + 1, elements[0].start);
  kept.forEach((index, position) => {
    const element = elements[index];
    if (position > 0) out += text.slice(elements[index - 1].node.end, element.start);
    out += text.slice(element.start, element.node.start) + renderElement(index);
  });
  const last = elements[elements.length - 1];
  return out + text.slice(last.node.end, node.end);
}

/**
 * Rebuilds a container with new elements appended. `renderElement` returns the new text of an existing
 * element's value; `appended` are full element texts (`"key": value` for objects), written at `childIndent`.
 */
export function renderAppended(
  text: string,
  node: JsonNode & { kind: 'object' | 'array' },
  appended: string[],
  renderElement: (index: number) => string,
  unit: string,
): string {
  const elements = elementsOf(node);
  const open = text[node.start];
  const close = text[node.end - 1];
  const parentIndent = lineIndent(text, node.start);
  if (elements.length === 0) {
    if (appended.length === 0) return text.slice(node.start, node.end);
    const child = parentIndent + unit;
    return `${open}\n${child}${appended.join(`,\n${child}`)}\n${parentIndent}${close}`;
  }
  let out = open + text.slice(node.start + 1, elements[0].start);
  elements.forEach((element, index) => {
    if (index > 0) out += text.slice(elements[index - 1].node.end, element.start);
    out += text.slice(element.start, element.node.start) + renderElement(index);
  });
  const last = elements[elements.length - 1];
  const child = lineIndent(text, last.start);
  for (const item of appended) out += `,\n${child}${item}`;
  return out + text.slice(last.node.end, node.end);
}
