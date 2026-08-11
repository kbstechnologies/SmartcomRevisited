import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// https://vitejs.dev/config
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  server: {
    // Bind IPv4 explicitly: vite defaults to `localhost`, which Node 18+
    // resolves to ::1 only, so `wait-on tcp:127.0.0.1` never fired and
    // electron never launched.
    host: '127.0.0.1',
    // Fixed port + strictPort: another project holds 5173, and silently
    // drifting to 5174 made electron load the stale built bundle instead.
    port: 5273,
    strictPort: true,
  },
})