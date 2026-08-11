import { defineConfig } from 'vite'
import { resolve } from 'path'
import { builtinModules } from 'module'

// Bundles scripts/db-smoke.ts the same way the main process is built, so the
// real DatabaseManager can be exercised under Electron's ABI.
const nodeExternals = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)]

export default defineConfig({
  build: {
    target: 'node18',
    minify: false,
    lib: {
      entry: resolve(__dirname, 'scripts/db-smoke.ts'),
      formats: ['cjs'],
      fileName: () => 'db-smoke.js',
    },
    rollupOptions: {
      external: ['electron', 'better-sqlite3', 'ssh2', 'serialport', ...nodeExternals],
    },
    outDir: 'dist-smoke',
    emptyOutDir: true,
  },
  resolve: {
    conditions: ['node'],
    alias: { '@shared': resolve(__dirname, 'src/shared') },
  },
})
