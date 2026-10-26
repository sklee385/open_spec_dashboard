import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { readFileSync } from 'node:fs'

const product = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(typeof product.version === 'string' ? product.version : null),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:13002',
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
  },
})
