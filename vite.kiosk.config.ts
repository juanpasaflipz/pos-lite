import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import path from 'path';

export default defineConfig({
  root: path.resolve(__dirname, 'kiosk'),
  base: '/kiosk/',
  plugins: [react()],
  publicDir: path.resolve(__dirname, 'kiosk/public'),
  css: {
    postcss: {
      plugins: [
        tailwindcss(path.resolve(__dirname, 'tailwind.config.js')),
        autoprefixer(),
      ],
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist-kiosk'),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5180,
    strictPort: false,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 5180,
  },
});
