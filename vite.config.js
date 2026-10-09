import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv } from 'vite';

// The application lives in ./frontend (index.html + css/ + js/ + public/).
// Vite builds it into ./dist, which is what Vercel serves as a static site.
//
// Only variables prefixed with VITE_ are ever exposed to the browser. Secrets
// (the Supabase service-role key, any Google OAuth secret, the Gmail token
// encryption key) must never be prefixed with VITE_ — they belong to the
// server-side functions under ./api and to the send worker's own environment.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// A loopback service URL is correct for local development and wrong for a
// deployment. The runtime refuses to use one (frontend/js/lib/endpoints.js), but
// warning here puts the mistake in the build log — the place an operator
// actually looks — instead of only in the browser console.
const LOOPBACK = /^https?:\/\/(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[?::1\]?|0\.0\.0\.0)(:|\/|$)/i;

function warnAboutLoopbackServiceUrls(env) {
  for (const name of ['VITE_MAIL_WORKER_URL', 'VITE_API_BASE_URL']) {
    const value = String(env[name] || '').trim();
    if (value && LOOPBACK.test(value)) {
      console.warn(
        `\n[vite] WARNING: ${name}=${value} points at this machine.\n` +
        '       A deployed site cannot reach it, so the app will treat the service as not ' +
        'configured and say so.\n' +
        '       Set the deployed service URL in the Vercel project environment variables ' +
        '(a localhost value is only honoured by a build that is itself served from this machine).\n',
      );
    }
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  if (process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production') {
    warnAboutLoopbackServiceUrls(env);
  }

  // The Gmail endpoints live in ./api and are served by Vercel on the same origin
  // as the site, so a production build needs no extra configuration. During local
  // `vite dev` there is no local server for them; point VITE_API_PROXY_TARGET at a
  // deployed origin to exercise the real backend while developing the UI.
  const apiProxyTarget = (process.env.VITE_API_PROXY_TARGET || '').trim();

  return {
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
  };
});
