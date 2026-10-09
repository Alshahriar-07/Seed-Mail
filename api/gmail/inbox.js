// GET /api/gmail/inbox
//
// One page of the user's real Gmail Inbox, read from Gmail with the app's OAuth
// grant. Nothing is cached in Postgres and no placeholder message is ever
// produced: an empty account yields an empty list, and a disconnected account
// yields a 409 telling the UI to offer "Connect Gmail".
//
// Query parameters (all optional):
//   q          Gmail search syntax, passed through unchanged
//   page_token Gmail's own continuation token from a previous response
//   max        page size (1–50)

import { requireAccessToken } from '../../backend/lib/connection.js';
import { listMailbox } from '../../backend/lib/mailbox.js';
import { queryOf, requireMethod, sendJson } from '../../backend/lib/http.js';
import { authed } from '../../backend/lib/handler.js';

export default authed(async (req, res, user) => {
  requireMethod(req, 'GET');
  const query = queryOf(req);

  const { accessToken } = await requireAccessToken(user.id);
  const page = await listMailbox(accessToken, {
    label: 'INBOX',
    query: String(query.q || '').slice(0, 500),
    pageToken: String(query.page_token || ''),
    maxResults: Number(query.max || 25),
  });

  return sendJson(res, 200, page);
});
