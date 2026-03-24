import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const reactPath = path.resolve(__dirname, 'node_modules/react')
const reactDomPath = path.resolve(__dirname, 'node_modules/react-dom')

export default defineConfig({
  plugins: [react()],
  base: './',
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
