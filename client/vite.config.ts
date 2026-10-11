import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

// при разработке API живёт отдельно: API_URL=http://localhost:8081 npm run dev
const api = process.env.API_URL ?? 'http://127.0.0.1:8081';

export default defineConfig({
  plugins: [preact()],
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  server: { proxy: { '/api': { target: api, ws: true } } },
});
