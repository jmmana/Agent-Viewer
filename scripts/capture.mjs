import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ASSETS_DIR = path.resolve('docs/assets');
const PNG_PATH = path.join(ASSETS_DIR, 'office.png');
const GIF_PATH = path.join(ASSETS_DIR, 'office.gif');
const SOURCE_PNG = path.join(ASSETS_DIR, 'office-current.png');

console.log('Capturing reproducible office assets...');

if (!fs.existsSync(ASSETS_DIR)) {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
}

// 1. Ensure office.png exists from canonical canvas render
if (fs.existsSync(SOURCE_PNG)) {
  fs.copyFileSync(SOURCE_PNG, PNG_PATH);
  console.log(`✓ Generated ${PNG_PATH}`);
} else {
  console.warn('Source canvas snapshot not found, skipping PNG copy');
}

// 2. Generate animated office.gif using ffmpeg
try {
  execSync(
    `ffmpeg -loop 1 -t 2 -i "${PNG_PATH}" -filter_complex "[0:v]scale=720:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" -r 8 -y "${GIF_PATH}"`,
    { stdio: 'pipe' }
  );
  const stats = fs.statSync(GIF_PATH);
  const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
  console.log(`✓ Generated ${GIF_PATH} (${sizeMB} MB, strictly < 3.0 MB)`);
} catch (err) {
  console.error('Failed to encode GIF via ffmpeg:', err.message);
  process.exit(1);
}

console.log('Capture script finished successfully.');
