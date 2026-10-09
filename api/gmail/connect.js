// POST /api/gmail/connect
//
// Starts the Google OAuth 2.0 authorization-code flow.
//
// Why POST (returning a URL) instead of a redirect from this endpoint: the
// request is authenticated with the user's bearer token, which a browser
// navigation cannot send. The SPA therefore asks for the consent URL with a
// normal authenticated fetch, then navigates to it. The user id is carried in
// the signed `state`, so the unauthenticated callback can still attribute the
// result to the right account without trusting anything the browser sends back.

import { googleOAuthConfigured } from '../../backend/lib/oauth.js';
import { requestOrigin, requireMethod, sendJson } from '../../backend/lib/http.js';
import { authed } from '../../backend/lib/handler.js';

export default authed(async (req, res, user) => {
  requireMethod(req, 'POST');

  const origin = requestOrigin(req);
  const { url, cookie } = googleOAuthConfigured(user, origin);

  if (cookie) res.setHeader('Set-Cookie', cookie);
  return sendJson(res, 200, { url });
});
