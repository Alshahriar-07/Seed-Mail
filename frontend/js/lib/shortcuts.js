// Seed Code Mail — keyboard shortcuts for the message reader
//
// The reading view is the one place where a user works through many messages in
// a row, so it is where a shortcut actually saves time. The mapping is a pure
// function of the key event so it can be tested without a browser, and the
// caller decides what each action does.
//
// Two rules matter more than the keys themselves:
//
//   1. **Never fire while the user is typing.** A shortcut that swallows an "e"
//      inside a search box or a reply draft is worse than no shortcut at all, so
//      anything typed into an input, textarea, select or contenteditable region
//      is ignored.
//   2. **Never fire with a modifier.** Ctrl+R, Cmd+R and Ctrl+F belong to the
//      browser; intercepting them would break reload and find.
//
// The keys follow the conventions Gmail established, so nothing has to be
// learned: `u` back, `r` reply, `f` forward, `e` archive, `#` delete.

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** True when a keystroke belongs to a text field rather than to the page. */
export function isTypingTarget(target) {
  if (!target) return false;
  const tag = String(target.tagName || '').toUpperCase();
  if (TYPING_TAGS.has(tag)) return true;
  return Boolean(target.isContentEditable);
}

/**
 * The action a key press means in the reading view, or '' for "do nothing".
 *
 * @param {{key?: string, target?: object, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean}} event
 * @returns {'back'|'reply'|'forward'|'archive'|'delete'|'toggle-read'|'newer'|'older'|''}
 */
export function readerAction({
  key = '',
  target = null,
  ctrlKey = false,
  metaKey = false,
  altKey = false,
} = {}) {
  if (ctrlKey || metaKey || altKey) return '';
  if (isTypingTarget(target)) return '';

  switch (String(key)) {
    case 'Escape':
    case 'u':
      return 'back';
    case 'r':
      return 'reply';
    case 'f':
      return 'forward';
    case 'e':
      return 'archive';
    case '#':
    case 'Delete':
      return 'delete';
    case 'i':
      return 'toggle-read';
    // Moving through a mailbox one message at a time is what the arrow keys do
    // in a list, so they are mapped to "the next/previous message" here. The
    // reader returns the list when there is nothing further to open.
    case 'j':
      return 'newer';
    case 'k':
      return 'older';
    default:
      return '';
  }
}

/**
 * The action a key press means in a mailbox list.
 *
 * @returns {'open'|'next'|'previous'|'compose'|'refresh'|'search'|''}
 */
export function listAction({
  key = '',
  target = null,
  ctrlKey = false,
  metaKey = false,
  altKey = false,
} = {}) {
  if (ctrlKey || metaKey || altKey) return '';
  if (isTypingTarget(target)) return '';

  switch (String(key)) {
    case 'Enter':
    case 'o':
      return 'open';
    case 'j':
      return 'next';
    case 'k':
      return 'previous';
    case 'c':
      return 'compose';
    case 'g':
      return 'refresh';
    case '/':
      return 'search';
    default:
      return '';
  }
}
