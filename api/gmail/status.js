// GET /api/gmail/status
//
// Reports two independent things, both truthfully:
//   * whether the *server* is configured for Gmail (variable names only), and
//   * whether *this user* has connected an account (address + granted scopes).
//
// It never returns a token, and it never claims Gmail is active when the OAuth
// client or the encryption key is missing — the UI shows the setup card instead.

import { describe } from '../../backend/lib/config.js';
import { connectionStatus } from '../../backend/lib/connection.js';
import { requireMethod, sendJson } from '../../backend/lib/http.js';
import { route } from '../../backend/lib/handler.js';
import { verifyUser } from '../../backend/lib/supabase.js';

export default route(async (req, res) => {
  requireMethod(req, 'GET');

  const configuration = describe();

  // Without the Supabase pair the server cannot identify the caller at all, so
  // there is nothing user-specific to report. Returning the configuration
  // (booleans + variable names) is safe and is exactly what the setup screen
  // needs, and it is better than a bare 503 the UI cannot explain.
  if (!configuration.auth_configured) {
    return sendJson(res, 200, { configured: false, configuration, connection: null });
  }

  const user = await verifyUser(req);

  // The connection row lives behind the service-role key; report "unknown"
  // rather than failing the whole status call when that key is absent.
  const connection = configuration.storage_configured
    ? await connectionStatus(user.id)
    : {
        connected: false,
        email: '',
        scopes: [],
        granted: false,
        status: 'unavailable',
        needs_reauth: false,
        missing_scopes: [],
        last_error: 'The server cannot read Gmail connections (SUPABASE_SERVICE_ROLE_KEY is not set).',
        connected_at: null,
        capabilities: { inbox: false, sent: false, send: false, modify: false, drafts: false },
      };

  return sendJson(res, 200, {
    configured: configuration.gmail_configured,
    configuration,
    connection,
  });
});
