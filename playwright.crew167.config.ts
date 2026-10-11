import { defineConfig } from '@playwright/test';
import base from './playwright.config';
export default defineConfig({ ...base, testMatch: /crew-engine-167\.spec\.ts/, use: { ...base.use, baseURL: 'http://127.0.0.1:3167' }, webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 3167', url: 'http://127.0.0.1:3167', reuseExistingServer: false } });
