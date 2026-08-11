import { defineConfig } from 'vite'
import { resolve } from 'path'
import { builtinModules } from 'module'

const nodeExternals = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]

export default defineConfig({
  build: {
    target: 'node18',
    minify: false,
    lib: {
      entry: resolve(__dirname, 'electron/preload.ts'),
      formats: ['cjs'],
      fileName: () => 'preload.js',
    },
    rollupOptions: {
      external: ['electron', ...nodeExternals],
    },
    outDir: 'dist-electron',
    emptyOutDir: false,
  },
  resolve: {
    conditions: ['node'],
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
})
