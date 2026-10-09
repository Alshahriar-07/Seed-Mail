// POST /api/gmail/send
//
// Sends an ordinary email through the user's connected Gmail account, or saves
// it as a Gmail draft when `draft: true`.
//
// The message is submitted by Gmail itself, so it appears in the user's real
// Sent mailbox with the normal Gmail headers and threading. The request is a
// single, bounded API call — no queue, no worker, and no Python process on the
// user's machine is involved.
//
// Honesty note surfaced to the UI: a successful submit returns the id Gmail
// assigned to the message. That means *Gmail accepted it*, which is not a
// guarantee that it reached the recipient's inbox, and the response says so.

import { requireAccessToken } from '../../backend/lib/connection.js';
import { createDraft, sendMessage } from '../../backend/lib/gmail.js';
import { badRequest, readJson, requireMethod, sendJson } from '../../backend/lib/http.js';
import { authed } from '../../backend/lib/handler.js';
import { buildRawMessage } from '../../backend/lib/mime.js';

const MAX_SUBJECT = 250;
const MAX_BODY = 500 * 1024; // ~500 KB of markup is far more than any real email

export default authed(async (req, res, user) => {
  requireMethod(req, 'POST');
  const body = await readJson(req);

  const subject = String(body.subject ?? '').slice(0, MAX_SUBJECT);
  const text = String(body.text ?? '').slice(0, MAX_BODY);
  const html = String(body.html ?? '').slice(0, MAX_BODY);

  if (!text.trim() && !html.trim()) {
    throw badRequest('Write a message body before sending.', 'empty_body');
  }
  if (Array.isArray(body.attachments) && body.attachments.length > 10) {
    throw badRequest('Too many attachments (10 maximum).', 'too_many_attachments');
  }

  const { accessToken, email } = await requireAccessToken(user.id);
  if (!email) {
    // The connection has no recorded address, so the From header cannot be
    // built truthfully. Reconnecting resolves it.
    throw badRequest(
      'The connected Gmail address is unknown. Reconnect your Gmail account from Profile.',
      'unknown_sender',
    );
  }

  let built;
  try {
    built = buildRawMessage({
      from: email,
      fromName: String(body.from_name ?? '').slice(0, 120),
      to: body.to,
      cc: body.cc,
      bcc: body.bcc,
      subject,
      text,
      html,
      attachments: Array.isArray(body.attachments) ? body.attachments : [],
    });
  } catch (error) {
    // The MIME builder reports validation problems in plain language (invalid
    // address, oversized attachment); pass that through as a 400.
    throw badRequest(String(error.message || 'The message could not be prepared.'), 'invalid_message');
  }

  const threadId = String(body.thread_id || '').slice(0, 200);

  if (body.draft === true) {
    const draft = await createDraft(accessToken, built.raw, { threadId });
    return sendJson(res, 200, {
      ok: true,
      saved_as_draft: true,
      draft_id: draft.id,
      message_id: draft.messageId,
      thread_id: '',
      from: email,
      recipients: { to: built.to, cc: built.cc, bcc: built.bcc },
      attachments: built.attachments,
      note: 'Saved as a Gmail draft. It is not sent until you send it from Gmail or Compose.',
    });
  }

  const sent = await sendMessage(accessToken, built.raw, { threadId });

  return sendJson(res, 200, {
    ok: true,
    saved_as_draft: false,
    message_id: sent.id,
    thread_id: sent.threadId,
    from: email,
    recipients: { to: built.to, cc: built.cc, bcc: built.bcc },
    attachments: built.attachments,
    // Gmail accepting the message is the strongest claim this endpoint can make.
    note: 'Gmail accepted the message for delivery. This is not a guarantee that it reached the recipient inbox.',
  });
});
