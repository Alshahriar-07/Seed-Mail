// Seed Code Mail — Supabase browser client
//
// Only the project URL and the *publishable* (anon) key are used here. They
// are public by design: access control is enforced by Row Level Security on
// every table (see supabase/migrations/0002_rls.sql), never by hiding a key.
//
// A Supabase secret / service-role key must never be referenced in this
// directory — anything imported from frontend/ ends up in the public bundle.

import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL || '';
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '';

export const supabaseConfigured = Boolean(url && publishableKey);

if (!supabaseConfigured) {
  // Surfaced in the UI by requireClient(); logged once so a misconfigured
  // deployment is obvious in the browser console.
  console.error(
    '[Seed Code Mail] Supabase is not configured. Set VITE_SUPABASE_URL and ' +
      'VITE_SUPABASE_PUBLISHABLE_KEY in frontend/.env (and in Vercel).',
  );
}

export const supabase = supabaseConfigured
  ? createClient(url, publishableKey, {
      auth: {
        // PKCE keeps the token exchange out of the URL fragment and works the
        // same on localhost, the beta URL and the production URL.
        flowType: 'pkce',
        persistSession: true,
        autoRefreshToken: true,
        // Session restoration after refresh is handled by the client.
        detectSessionInUrl: true,
        storageKey: 'seedmail.auth',
      },
      global: { headers: { 'x-application-name': 'seed-code-mail' } },
    })
  : null;

export function requireClient() {
  if (!supabase) {
    throw new Error(
      'Supabase is not configured. Add VITE_SUPABASE_URL and ' +
        'VITE_SUPABASE_PUBLISHABLE_KEY to frontend/.env, then rebuild.',
    );
  }
  return supabase;
}

/** Current access token (used only to authenticate calls to the local worker). */
export async function currentAccessToken() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data?.session?.access_token || null;
}
