import { defineConfig } from 'vite';

// The application lives in ./frontend (index.html + css/ + js/ + public/).
// Vite builds it into ./dist, which is what Vercel serves as a static site.
//
// Only variables prefixed with VITE_ are ever exposed to the browser. Secrets
// (the Gmail App Password, any service-role key) must never be prefixed with
// VITE_ — they belong to the send worker's own environment.
export default defineConfig({
  root: 'frontend',
  publicDir: 'public',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  preview: {
    port: 4173,
  },
});
