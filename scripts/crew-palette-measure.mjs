import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decodificador mínimo de PNG (RGBA de 8 bits, sin entrelazar), sin dependencias externas:
 * solo zlib de Node para inflar los IDAT y la reconstrucción de filtros del propio formato PNG.
 * No sirve para paletas indexadas, escala de grises ni PNG entrelazados (todo el banco Crew es RGBA 8-bit).
 */
export function decodePng(bytes) {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('PNG inválido');
  let offset = 8;
  let width = 0, height = 0;
  const idatChunks = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    if (type === 'IHDR') {
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      const bitDepth = bytes[dataStart + 8];
      const colorType = bytes[dataStart + 9];
      const interlace = bytes[dataStart + 12];
      if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
        throw new Error('Formato PNG no soportado: se requiere RGBA de 8 bits sin entrelazar');
      }
    } else if (type === 'IDAT') {
      idatChunks.push(bytes.subarray(dataStart, dataStart + length));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataStart + length + 4;
  }
  if (!width || !height) throw new Error('PNG sin cabecera IHDR válida');
  const raw = inflateSync(Buffer.concat(idatChunks));
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const pixels = new Uint8Array(width * height * bytesPerPixel);
  let prevLine = new Uint8Array(stride);
  let rawOffset = 0;
  for (let y = 0; y < height; y++) {
    const filterType = raw[rawOffset];
    rawOffset += 1;
    const line = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[rawOffset + x];
      const a = x >= bytesPerPixel ? line[x - bytesPerPixel] : 0;
      const b = prevLine[x];
      const c = x >= bytesPerPixel ? prevLine[x - bytesPerPixel] : 0;
      let value;
      switch (filterType) {
        case 0: value = rawByte; break;
        case 1: value = rawByte + a; break;
        case 2: value = rawByte + b; break;
        case 3: value = rawByte + Math.floor((a + b) / 2); break;
        case 4: value = rawByte + paeth(a, b, c); break;
        default: throw new Error(`Filtro PNG no soportado: ${filterType}`);
      }
      line[x] = value & 0xff;
    }
    pixels.set(line, y * stride);
    prevLine = line;
    rawOffset += stride;
  }
  return { width, height, data: pixels };
}

function rgbToHsl(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0));
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: h * 60, s, l };
}

function hueInRange(hueDeg, lo, hi) {
  const h = ((hueDeg % 360) + 360) % 360;
  return lo <= hi ? h >= lo && h <= hi : h >= lo || h <= hi;
}

const QUANT_LEVELS = 16;
function quantize(value) {
  const step = 256 / QUANT_LEVELS;
  return Math.min(255, Math.floor(value / step) * step + step / 2);
}

/**
 * Mide el color dominante de la prenda/silueta de un rol a partir de su PNG `idle-front`,
 * documentado en la sección 6 de docs/crew/visual-style-contract.md: cuantización de 16 niveles,
 * alfa >= 200, y exclusión explícita de contorno/cabello oscuro (tono rojizo/marrón muy oscuro) y
 * piel clara (tono piel con luminosidad alta) para no confundirlos con la prenda que distingue al rol.
 * No decide ni ratifica un color final de arte: solo hace reproducible y verificable por prueba
 * la medición que antes se describía en prosa sin ningún script que la respaldara.
 */
export function measureRoleSwatch(pngBytes) {
  const { width, height, data } = decodePng(pngBytes);
  const counts = new Map();
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const r = data[o], g = data[o + 1], b = data[o + 2], a = data[o + 3];
    if (a < 200) continue;
    const { h, s, l } = rgbToHsl(r, g, b);
    if (s < 0.12) continue; // casi neutro: contorno negro, blanco o gris
    if (hueInRange(h, 330, 50) && l < 0.30) continue; // cabello/contorno oscuro (familia marrón)
    if (hueInRange(h, 10, 55) && l > 0.55) continue; // piel clara (familia durazno)
    const key = `${quantize(r)},${quantize(g)},${quantize(b)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let bestKey = null, bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) { bestCount = count; bestKey = key; }
  }
  if (!bestKey) throw new Error('No se encontró un color dominante fuera de piel/cabello/neutros');
  const [r, g, b] = bestKey.split(',').map(Number);
  const hex = `#${[r, g, b].map(v => v.toString(16).padStart(2, '0').toUpperCase()).join('')}`;
  const totalMasked = [...counts.values()].reduce((sum, c) => sum + c, 0);
  return { hex, sampleCount: bestCount, maskedPixelCount: totalMasked };
}

export const NON_CEO_ROLES = ['analyst', 'developer', 'finance', 'planner', 'reviewer'];

export function measureAllNonCeoRoles(root = process.cwd()) {
  const results = {};
  for (const role of NON_CEO_ROLES) {
    const path = resolve(root, `assets/crew/bank/characters/${role}/idle-front.png`);
    results[role] = measureRoleSwatch(readFileSync(path));
  }
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(measureAllNonCeoRoles(), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
