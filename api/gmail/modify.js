// POST /api/gmail/modify  { id, read }            → read / unread
// POST /api/gmail/modify  { id, action }          → 'read' | 'unread' | 'archive' | 'trash'
//
// Every action here changes real mailbox state in Gmail itself (a label change or
// the Trash), so the same message looks the same in Gmail. Nothing is simulated
// and no local flag stands in for a Gmail change.
//
// These are the operations `gmail.modify` actually grants:
//   * read/unread  — add/remove the UNREAD label;
//   * archive      — remove the INBOX label (kept in All Mail);
//   * trash        — Gmail's `messages.trash` (recoverable for 30 days).
// Permanent deletion (`messages.delete`) is NOT offered: it requires the
// all-or-nothing `https://mail.google.com/` scope, which this application never
// requests, so offering a "delete forever" button would be a button that fails.
//
// If a user granted a narrower scope set, Gmail rejects the call and the error is
// surfaced rather than hidden.

import { requireAccessToken } from '../../backend/lib/connection.js';
import { archiveMessage, modifyMessage, trashMessage } from '../../backend/lib/gmail.js';
import { badRequest, readJson, requireMethod, sendJson } from '../../backend/lib/http.js';
import { authed } from '../../backend/lib/handler.js';

// The actions this endpoint implements, and nothing more: an unknown value is a
// bad request rather than a silent no-op.
const ACTIONS = new Set(['read', 'unread', 'archive', 'trash']);

export default authed(async (req, res, user) => {
  requireMethod(req, 'POST');
  const body = await readJson(req);

  const id = String(body.id || '').trim();
  if (!id || id.length > 200) throw badRequest('A valid message id is required.', 'invalid_id');

  // `read` (a boolean) is the original contract and is still accepted so an
  // older page in a cached bundle keeps working against a newer deployment.
  let action = '';
  if (typeof body.read === 'boolean') {
    action = body.read ? 'read' : 'unread';
  } else if (typeof body.action === 'string') {
    action = body.action.trim().toLowerCase();
  }
  if (!ACTIONS.has(action)) {
    throw badRequest(
      'Provide `read` (true/false) or one of these `action` values: read, unread, archive, trash.',
      'invalid_body',
    );
  }

  const { accessToken } = await requireAccessToken(user.id);

  if (action === 'archive') {
    await archiveMessage(accessToken, id);
  } else if (action === 'trash') {
    await trashMessage(accessToken, id);
  } else {
    await modifyMessage(accessToken, id, action === 'read'
      ? { removeLabelIds: ['UNREAD'] }
      : { addLabelIds: ['UNREAD'] });
  }

  return sendJson(res, 200, {
    ok: true,
    id,
    action,
    // `read` stays in the payload for the read/unread actions so existing callers
    // read the same field they always did.
    ...(action === 'read' || action === 'unread' ? { read: action === 'read' } : {}),
  });
});
