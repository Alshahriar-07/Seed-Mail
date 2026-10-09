import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// The application lives in ./frontend (index.html + css/ + js/ + public/).
// Vite builds it into ./dist, which is what Vercel serves as a static site.
//
// Only variables prefixed with VITE_ are ever exposed to the browser. Secrets
// (the Supabase service-role key, any Google OAuth secret, the Gmail token
// encryption key) must never be prefixed with VITE_ — they belong to the
// server-side functions under ./api and to the send worker's own environment.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// The Gmail endpoints live in ./api and are served by Vercel on the same origin
// as the site, so a production build needs no extra configuration. During local
// `vite dev` there is no local server for them; point VITE_API_PROXY_TARGET at a
// deployed origin to exercise the real backend while developing the UI.
const apiProxyTarget = (process.env.VITE_API_PROXY_TARGET || '').trim();

export default defineConfig({
  root: 'frontend',
  publicDir: 'public',
  define: {
    // Surfaces the real project version in the About page instead of a
    // hand-maintained constant that drifts from package.json.
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: apiProxyTarget
      ? { '/api': { target: apiProxyTarget, changeOrigin: true, secure: true } }
      : undefined,
  },
  preview: {
    port: 4173,
  },
});
