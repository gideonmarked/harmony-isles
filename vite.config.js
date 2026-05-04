import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: 'public',
  // Relative asset paths instead of absolute (`./assets/...` not
  // `/assets/...`). Means the dist folder works under any host path
  // — subpath deployments, Electron shells, GitHub Pages — without
  // a config change. Doesn't make file:// work (ES modules are
  // CORS-blocked there regardless), but keeps the bundle portable.
  base: './',
  server: {
    port: 5173,
    open: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
    rollupOptions: {
      output: {
        // Split vendor libs into their own chunks. Three.js alone is
        // the chunk-size warning's culprit (~600 KB minified); Howler
        // is much smaller but goes alongside for the same caching
        // reason — vendor chunks only re-download when their deps
        // bump in package.json, while the app chunk re-downloads on
        // every code change.
        manualChunks: {
          three: ['three'],
          howler: ['howler'],
        },
      },
    },
  },
});
