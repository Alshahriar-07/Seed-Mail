// GET /api/gmail/sent
//
// One page of the user's real Gmail **Sent** mailbox (`labelIds=SENT`), read from
// Gmail. This shows messages Gmail actually accepted for delivery.
//
// It is deliberately NOT the same thing as the application's campaign history:
// a queued campaign job is not "sent", and this endpoint never presents one as
// such. Campaign submission state lives in `email_history` / `campaigns`, and
// Gmail's Sent label reflects what Gmail itself holds.

import { requireAccessToken } from '../../backend/lib/connection.js';
import { listMailbox } from '../../backend/lib/mailbox.js';
import { queryOf, requireMethod, sendJson } from '../../backend/lib/http.js';
import { authed } from '../../backend/lib/handler.js';

export default authed(async (req, res, user) => {
  requireMethod(req, 'GET');
  const query = queryOf(req);

  const { accessToken } = await requireAccessToken(user.id);
  const page = await listMailbox(accessToken, {
    label: 'SENT',
    query: String(query.q || '').slice(0, 500),
    pageToken: String(query.page_token || ''),
    maxResults: Number(query.max || 25),
  });

  return sendJson(res, 200, page);
});
