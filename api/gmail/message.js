// GET /api/gmail/message?id=<gmail message id>
//
// Full content of one Gmail message: headers, both body representations, and
// the attachment list. Gmail message ids are the identifiers used throughout the
// mailbox features — the same id a campaign job records when it can report one.

import { requireAccessToken } from '../../backend/lib/connection.js';
import { readMessage } from '../../backend/lib/mailbox.js';
import { badRequest, queryOf, requireMethod, sendJson } from '../../backend/lib/http.js';
import { authed } from '../../backend/lib/handler.js';

export default authed(async (req, res, user) => {
  requireMethod(req, 'GET');
  const id = String(queryOf(req).id || '').trim();
  if (!id || id.length > 200) throw badRequest('A valid message id is required.', 'invalid_id');

  const { accessToken } = await requireAccessToken(user.id);
  return sendJson(res, 200, { message: await readMessage(accessToken, id) });
});
