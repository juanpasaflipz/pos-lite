/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
    './kiosk/index.html',
    './kiosk/src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Single platform brand across every tenant (Tailwind blue, anchored
        // on cockpit-blue #4285F4 ≈ blue-500 #3b82f6). Used to be a per-tenant
        // CSS-variable override; the override mechanism was removed when we
        // unified the look. Keep using `brand-*` classes everywhere — they
        // now resolve to one shared blue scale.
        brand: {
          50:  '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          300: '#93c5fd',
          400: '#60a5fa',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
          800: '#1e40af',
          900: '#1e3a8a',
        },
        // Cockpit zone palette (Google 4-color: blue/red/yellow/green)
        cockpit: {
          blue:   '#4285F4', // SYSTEM
          red:    '#EA4335', // OUT
          yellow: '#FBBC05', // reserved for warnings
          green:  '#34A853', // IN
        },
        // Override neutral palette with CSS variables for theme switching
        neutral: {
          50:  'rgb(var(--n-50)  / <alpha-value>)',
          100: 'rgb(var(--n-100) / <alpha-value>)',
          200: 'rgb(var(--n-200) / <alpha-value>)',
          300: 'rgb(var(--n-300) / <alpha-value>)',
          400: 'rgb(var(--n-400) / <alpha-value>)',
          500: 'rgb(var(--n-500) / <alpha-value>)',
          600: 'rgb(var(--n-600) / <alpha-value>)',
          700: 'rgb(var(--n-700) / <alpha-value>)',
          800: 'rgb(var(--n-800) / <alpha-value>)',
          900: 'rgb(var(--n-900) / <alpha-value>)',
          950: 'rgb(var(--n-950) / <alpha-value>)',
        },
      },
    },
  },
  plugins: [],
}
