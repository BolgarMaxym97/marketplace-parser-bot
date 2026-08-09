import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      singleWorker: true,
      miniflare: {
        compatibilityDate: '2026-08-01',
        d1Databases: ['DB'],
        bindings: {
          BOT_TOKEN: 'test-token',
          WEBHOOK_SECRET: 'test-secret',
          OWNER_CHAT_ID: '777',
          PHOTO_SIZE: '1000x700',
          TIMEZONE: 'Europe/Kyiv',
        },
      },
    }),
  ],
});
