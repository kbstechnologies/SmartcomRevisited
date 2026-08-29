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
        // node-pty finds `pty.node` — and on Windows `conpty.dll`, OpenConsole
        // and the winpty agent it spawns — by walking up from its own
        // `__dirname`. Bundled into dist-electron that lookup lands in the
        // wrong directory and the module fails to load at all, so it has to be
        // required from node_modules like the other native modules.
        'node-pty',
        'electron-squirrel-startup',
        'electron-updater',
        ...nodeExternals,
      ],
    },
    outDir: 'dist-electron',
    // Must stay false: the preload build writes to the same directory, so
    // either build emptying it would delete the other's output. The directory
    // is cleaned once by `build:electron` instead — without that, Vite's hashed
    // chunks accumulate forever and every past build's main bundle is packaged
    // into the installer (20 stale chunks, ~13 MB, as of 1.1.0).
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
