import { defineConfig } from 'vite'
import { resolve } from 'path'
import { builtinModules } from 'module'

// Node builtins must stay external — Vite otherwise browser-shims them
// (`__vite-browser-external`) and named imports like `join` from 'path' break.
const nodeExternals = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]

export default defineConfig({
  build: {
    target: 'node18',
    minify: false,
    lib: {
      entry: resolve(__dirname, 'electron/main.ts'),
      formats: ['cjs'],
      fileName: () => 'main.js',
    },
    rollupOptions: {
      external: [
        'electron',
        'better-sqlite3',
        'ssh2',
        'serialport',
        '@serialport/bindings-cpp',
        'electron-squirrel-startup',
        'electron-updater',
        ...nodeExternals,
      ],
    },
    outDir: 'dist-electron',
    emptyOutDir: false,
  },
  resolve: {
    // Prefer Node resolution over browser field for main-process deps
    conditions: ['node'],
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
})
