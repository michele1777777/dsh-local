import { defineConfig } from 'tsdown'

// Ship one production React/Ink renderer. Node's unset NODE_ENV otherwise selects
// the development reconciler, whose per-component timing entries accumulate.
export default defineConfig({
  entry: ['lib/types/{index,startup}.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  deps: {
    alwaysBundle: [/^(?:ink|react|react-reconciler|scheduler)(?:\/|$)/],
    neverBundle: ['react-devtools-core'],
  },
})
