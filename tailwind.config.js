/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: 'var(--brand-50, #f0fdfa)',
          100: 'var(--brand-100, #ccfbf1)',
          200: 'var(--brand-200, #99f6e4)',
          300: 'var(--brand-300, #5eead4)',
          400: 'var(--brand-400, #2dd4bf)',
          500: 'var(--brand-500, #14b8a6)',
          600: 'var(--brand-600, #0d9488)',
          700: 'var(--brand-700, #0f766e)',
          800: 'var(--brand-800, #115e59)',
          900: 'var(--brand-900, #134e4a)',
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
