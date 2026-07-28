import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'
// @ts-expect-error — plain ESM helper, shared with the server and the kiosk build
import { resolveAppVersion } from './scripts/app-version.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appVersion = resolveAppVersion()
const reactPath = path.resolve(__dirname, 'node_modules/react')
const reactDomPath = path.resolve(__dirname, 'node_modules/react-dom')

export default defineConfig({
  plugins: [react()],
  base: './',
  define: {
    __APP_BUILD_ID__: JSON.stringify(appVersion.buildId),
    __APP_VERSION__: JSON.stringify(appVersion.version),
    __APP_COMMIT__: JSON.stringify(appVersion.commit),
    __APP_BUILT_AT__: JSON.stringify(appVersion.builtAt),
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      'react': reactPath,
      'react-dom': reactDomPath,
    },
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/admin': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'ui-vendor': ['lucide-react'],
          'stripe': ['@stripe/stripe-js'],
          'offline': ['dexie'],
          'i18n': ['i18next', 'react-i18next'],
          'recharts': ['recharts'],
        },
      },
    },
  },
})
