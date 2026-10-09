// Seed Code Mail — route wrappers
//
// Every handler ends in one of these, so an unexpected exception becomes a safe
// JSON error instead of a leaked stack trace, and so no route can accidentally
// forget to verify the caller.

import { describe } from './config.js';
import { sendError, sendJson } from './http.js';
import { verifyUser } from './supabase.js';

/** Wrap a handler so any thrown error becomes a JSON response. */
export function route(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      sendError(res, error);
    }
  };
}

/**
 * Wrap a handler so it only runs for a verified signed-in user.
 * The user object comes from Supabase Auth — never from the request.
 */
export function authed(handler) {
  return route(async (req, res) => {
    const user = await verifyUser(req);
    await handler(req, res, user);
  });
}

/**
 * The server's configuration report. Safe to serve to a signed-in user: it
 * contains booleans, public scope names and variable names only — never a value.
 * It is what lets the UI tell an operator exactly which variable to set instead
 * of showing a generic "something went wrong".
 */
export function configurationPayload() {
  return describe();
}

export { sendJson };
