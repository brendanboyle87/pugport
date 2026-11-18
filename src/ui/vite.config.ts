import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  // Relative to the working directory (the repo root), not to this file.
  root: 'src/ui',
  plugins: [react()],
  base: '/',
  define: {
    __PUGPORT_UI_BUILD_ID__: JSON.stringify('development'),
    __PUGPORT_UI_COMPATIBILITY__: JSON.stringify('development'),
  },
  build: { outDir: '../../dist/ui', emptyOutDir: true },
  server: { host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:4317' } },
});
