/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './frontend/**/*.{html,js}',
    './backend/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        primary: '#8B5CF6',
        violet: '#8B5CF6',
        ink: '#0F0F0F',
        surface: '#1A1A1A',
        'surface-variant': '#2A2A2A',
        'border-color': '#333333',
        'text-primary': '#FFFFFF',
        'text-secondary': '#B0B0B0',
        'text-tertiary': '#808080',
        'muted-foreground': '#808080',
      },
      fontFamily: {
        body: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Helvetica Neue', 'Arial', 'sans-serif'],
        display: ['Georgia', 'Times New Roman', 'serif'],
        mono: ['Monaco', 'Courier New', 'monospace'],
      },
    },
  },
  plugins: [],
}
