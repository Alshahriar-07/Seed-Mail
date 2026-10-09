// Seed Code Mail — Inbox page
//
// Real Gmail Inbox, read through the trusted backend. All of the state
// handling (setup, disconnected, reauth, loading, empty, error) lives in
// mail-common.js, so this page is only the Gmail-specific wiring.

import { gmail } from './lib/gmail.js';
import { renderMailbox } from './mail-common.js';

export async function render(container) {
  return renderMailbox(container, {
    mailbox: 'inbox',
    load: gmail.inbox,
    iconName: 'inbox',
    emptyTitle: 'Your Gmail inbox is empty',
    emptyMessage: 'Messages will appear here as your Gmail account receives them. Nothing is copied into Seed Code Mail.',
  });
}
