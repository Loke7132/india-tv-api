import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/india-tv-api/',
  plugins: [react()],
  root: 'web',
  build: {
    outDir: '../public',
    emptyOutDir: true,
    sourcemap: true
  }
})
