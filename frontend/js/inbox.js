// Seed Code Mail — Inbox page
//
// Real Gmail Inbox, read through the trusted backend. All of the state handling
// (setup, disconnected, reauth, loading, empty, error) lives in mail-common.js,
// so this page is only the Gmail-specific wiring.
//
// `#/inbox` shows the list; `#/inbox/<message-id>` shows one message in the main
// content area. The message id is part of the route (not an overlay) so the
// browser Back button returns to the list, and a message can be linked or
// refreshed.

import { gmail } from './lib/gmail.js';
import { renderMailbox, renderReader } from './mail-common.js';

export async function render(container, { params = [] } = {}) {
  const [messageId] = params;
  if (messageId) return renderReader(container, { mailbox: 'inbox', messageId });

  return renderMailbox(container, {
    mailbox: 'inbox',
    load: gmail.inbox,
    iconName: 'inbox',
    emptyTitle: 'Your Gmail inbox is empty',
    emptyMessage: 'Messages will appear here as your Gmail account receives them. Nothing is copied into Seed Code Mail.',
  });
}
