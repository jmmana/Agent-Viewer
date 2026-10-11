import { defineConfig } from '@playwright/test';
import base from './playwright.config';
export default defineConfig({ ...base, testMatch: /crew-desktop.spec.ts/, use: { ...base.use, baseURL: 'http://127.0.0.1:3118', viewport: { width: 1440, height: 1000 } }, webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 3118', url: 'http://127.0.0.1:3118', reuseExistingServer: false } });
