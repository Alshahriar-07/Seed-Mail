// GET /api/gmail/attachment?message_id=…&attachment_id=…&filename=…
//
// Downloads one attachment through Gmail's authorized API. The bytes are only
// reachable while the signed-in owner has an authorized Gmail connection, so no
// attachment is ever exposed on a public URL.
//
// The payload is returned base64-encoded inside JSON; the browser turns it into
// a Blob and triggers the download. That keeps one response shape for every
// endpoint and avoids guessing a content type on the server.

import { requireAccessToken } from '../../backend/lib/connection.js';
import { getAttachment } from '../../backend/lib/gmail.js';
import { badRequest, queryOf, requireMethod, sendJson } from '../../backend/lib/http.js';
import { authed } from '../../backend/lib/handler.js';

// Gmail can return large attachments; cap what one response will carry.
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export default authed(async (req, res, user) => {
  requireMethod(req, 'GET');
  const query = queryOf(req);

  const messageId = String(query.message_id || '').trim();
  const attachmentId = String(query.attachment_id || '').trim();
  if (!messageId || messageId.length > 200) throw badRequest('message_id is required.', 'invalid_message_id');
  if (!attachmentId || attachmentId.length > 400) throw badRequest('attachment_id is required.', 'invalid_attachment_id');

  const { accessToken } = await requireAccessToken(user.id);
  const attachment = await getAttachment(accessToken, messageId, attachmentId);

  if (attachment.size > MAX_ATTACHMENT_BYTES) {
    throw badRequest('This attachment is too large to download in the browser.', 'attachment_too_large');
  }

  return sendJson(res, 200, {
    message_id: messageId,
    attachment_id: attachmentId,
    filename: String(query.filename || 'attachment').slice(0, 200),
    size: attachment.size,
    data: attachment.data,
  });
});
