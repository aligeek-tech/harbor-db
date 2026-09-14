import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'
export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { external: ['node:sqlite'] } } },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.js' } } },
  },
  renderer: {
    resolve: { alias: { '@': resolve('src/renderer/src'), '@shared': resolve('src/shared') } },
    plugins: [react(), tailwindcss()],
    server: { host: '127.0.0.1' },
    build: { chunkSizeWarningLimit: 3000 },
  },
})
