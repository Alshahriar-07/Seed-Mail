// POST /api/gmail/disconnect
//
// Removes the stored Gmail connection for the signed-in user. This deliberately
// does NOT touch the user's Supabase account, recipients, campaigns, templates
// or email history: disconnecting a mailbox must not delete application data.
//
// The refresh token is revoked at Google first (best effort) so a copy is not
// left usable, then the local row is deleted regardless — a network failure must
// not leave the user unable to disconnect.

import { decryptSecret } from '../../backend/lib/crypto.js';
import { tokenEncryptionKey } from '../../backend/lib/config.js';
import { deleteConnection } from '../../backend/lib/connection.js';
import { revokeToken } from '../../backend/lib/gmail.js';
import { requireMethod, sendJson } from '../../backend/lib/http.js';
import { authed } from '../../backend/lib/handler.js';
import { getConnection } from '../../backend/lib/supabase.js';

export default authed(async (req, res, user) => {
  requireMethod(req, 'POST');

  const row = await getConnection(user.id);
  if (!row) {
    // Idempotent: disconnecting an account that is not connected is a no-op.
    return sendJson(res, 200, { ok: true, connected: false });
  }

  const key = tokenEncryptionKey();
  if (row.token_ciphertext && key) {
    try {
      await revokeToken(decryptSecret(row.token_ciphertext, key));
    } catch (_) {
      // Already invalid, or the key changed. The row is removed below anyway.
    }
  }

  await deleteConnection(user.id);
  return sendJson(res, 200, { ok: true, connected: false });
});
