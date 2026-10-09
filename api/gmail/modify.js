// POST /api/gmail/modify  { id, read }
//
// Marks one message read or unread by adding/removing Gmail's UNREAD label.
// This changes real mailbox state in Gmail (not a local flag), so the same
// message shows as read in Gmail itself.
//
// Requires the gmail.modify scope, which the app requests only because this
// feature exists. If a user granted a narrower set, Gmail rejects the call and
// the error is surfaced rather than hidden.

import { requireAccessToken } from '../../backend/lib/connection.js';
import { modifyMessage } from '../../backend/lib/gmail.js';
import { badRequest, readJson, requireMethod, sendJson } from '../../backend/lib/http.js';
import { authed } from '../../backend/lib/handler.js';

export default authed(async (req, res, user) => {
  requireMethod(req, 'POST');
  const body = await readJson(req);

  const id = String(body.id || '').trim();
  if (!id || id.length > 200) throw badRequest('A valid message id is required.', 'invalid_id');
  if (typeof body.read !== 'boolean') throw badRequest('`read` must be true or false.', 'invalid_body');

  const { accessToken } = await requireAccessToken(user.id);
  await modifyMessage(accessToken, id, body.read
    ? { removeLabelIds: ['UNREAD'] }
    : { addLabelIds: ['UNREAD'] });

  return sendJson(res, 200, { ok: true, id, read: body.read });
});
