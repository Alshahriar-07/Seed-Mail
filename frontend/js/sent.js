// Seed Code Mail — Sent page
//
// This is Gmail's own Sent mailbox, not the application's campaign queue. A
// campaign message only appears here once Gmail has actually accepted it, which
// is why the page never presents a queued job as "sent". Campaign submission
// state (queued / processing / submitted / failed / unknown) lives on the
// Campaigns page and in Email History.

import { gmail } from './lib/gmail.js';
import { renderMailbox } from './mail-common.js';

export async function render(container) {
  return renderMailbox(container, {
    mailbox: 'sent',
    load: gmail.sent,
    iconName: 'send',
    emptyTitle: 'Nothing in Sent yet',
    emptyMessage: 'Messages you send with Compose — and campaign messages Gmail accepted — appear here.',
  });
}
