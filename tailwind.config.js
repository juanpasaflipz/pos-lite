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
        // Brand = enamel blue (vintage Mexican signage / workwear), anchored on
        // SYSTEM primary #2E5EAA. This is the single platform brand across every
        // tenant — used for primary actions everywhere. Distinct from cockpit
        // semantics; same hex as cockpit.system to keep the operator's mental
        // model coherent (infrastructure actions wear infrastructure color).
        brand: {
          50:  '#eef3fa',
          100: '#d7e2f2',
          200: '#b0c5e5',
          300: '#87a8d8',
          400: '#6e97db', // SYSTEM hover
          500: '#4b7ac7', // SYSTEM secondary
          600: '#2e5eaa', // SYSTEM primary
          700: '#244a88',
          800: '#1b3766',
          900: '#122448',
          950: '#0f1728', // SYSTEM dark bg
        },
        // Cockpit zone palette — semantic operational meanings, not aesthetic
        // choices. Each color carries exactly one meaning so operators can scan
        // a screen in <1 second and know what's going on.
        //
        // The `-text` variants are SAME-meaning, different rendering context:
        // luminance-boosted siblings tuned for legible text on dark surfaces.
        // The cockpit primaries are saturated mid-darks designed for fills,
        // borders, and chart markers — they don't have enough contrast on dark
        // for inline text. Use `-text` shades whenever the color appears as
        // text on a dark background (table cells, tooltip values, label spans).
        cockpit: {
          // Semantic aliases — prefer these in new code.
          in:               '#1F5B34', // Burrito Green — money in, success, healthy
          'in-text':        '#5FA47C', // text-on-dark sibling of `in`
          out:              '#C94B1B', // Burnt Orange — pressure, loss, heat
          'out-text':       '#E6885F', // text-on-dark sibling of `out`
          system:           '#2E5EAA', // Enamel Blue — infrastructure, primary action
          'system-text':    '#6E97DB', // = brand-400 hover; text-on-dark sibling of `system`
          attention:        '#D9A021', // Mustard Yellow — pending/warning/caution (single layer)
          'attention-text': '#E8C26A', // text-on-dark sibling of `attention`
          // Legacy keys (kept so existing cockpit-blue/-red/-yellow/-green
          // classes keep resolving). Same hexes as the semantic aliases above.
          blue:   '#2E5EAA',
          red:    '#C94B1B',
          yellow: '#D9A021',
          green:  '#1F5B34',
        },
        // Environmental palette — atmosphere, NOT semantic meaning.
        // Use for backgrounds/surfaces/borders/ambient text. Never use these
        // to communicate operational state (that's what cockpit-* is for).
        surface: {
          bg:     '#0A0A0A', // main canvas
          warm:   '#15120E', // warm card / panel
          border: '#2A2A2A', // soft divider
          cream:  '#D8C7A3', // tortilla cream — accent surface, not a zone
        },
        ink: {
          warm: '#F5F1E8', // warm white text on dark
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
