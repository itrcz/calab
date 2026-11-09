import type { ruDm } from '../ru/dm';
import type { DictShape } from '../types';

/**
 * English UI strings — direct messages (ADR-0020, ADR-0022). Same rules as ru: flat dotted keys,
 * `{param}` placeholders, short, verb-first, no exclamation marks (docs/08).
 */
export const enDm: DictShape<typeof ruDm> = {
  'dm.home': 'Direct messages',
  'dm.homeUnread': 'Direct messages, unread: {n}',
  'dm.list': 'Direct messages',
  'dm.new': 'New message',
  'dm.empty': 'No direct messages yet',
  'dm.emptyHint': 'Message a teammate: use “New message”, their profile or the member menu.',
  'dm.pickTitle': 'Direct messages',
  'dm.pickText': 'Pick a conversation on the left or start a new one.',
  'dm.you': 'You',
  'dm.noMessages': 'No messages',
  'dm.placeholder': 'Message @{name}',
  'dm.searchIn': 'Search in conversation',
  'dm.searchMessages': 'Search messages',
  'dm.searchChats': 'Chats',
  'dm.searchFailed': 'Search failed. Try again.',
  'dm.write': 'Message',
  'dm.welcomeText': 'This is the beginning of your direct message history.',
  'dm.markRead': 'Mark as read',
  'dm.copyLink': 'Copy link',
  'dm.linkCopied': 'Link copied',
  'dm.chat': 'Conversation with {name}',
  // “New message”
  'dm.newTitle': 'New message',
  'dm.newSearch': 'Name or nickname',
  'dm.newHint': 'You can message members of your workspaces.',
  'dm.newEmpty': 'No one found',
  'dm.newFailed': 'Couldn’t load the list',
  // errors of POST /api/dms
  'dm.errRateLimited': 'Too many new conversations — try again later',
  'dm.errGuest': 'Direct messages aren’t available to guests',
  'dm.errNoCommon': 'You don’t share a workspace with this person',
  'dm.errSelf': 'You can’t message yourself',
  'dm.errCreate': 'Couldn’t start the conversation',
  // a /dm/<id> link of someone else's (or a deleted) conversation
  'dm.errLink': 'This conversation isn’t available: it isn’t yours or it was deleted',
  // archive and «delete for me» (docs/09 #51)
  'dm.archive': 'Archive',
  'dm.unarchive': 'Unarchive',
  'dm.archiveSection': 'Archive — {n}',
  'dm.deleteTitle': 'Delete chat?',
  'dm.deleteConfirm': 'The history will be deleted only for you; the other person keeps it.',
  'dm.errState': 'Couldn’t update the conversation',
  'dm.actions': 'Conversation actions',
  // quick switcher
  'search.dms': 'Direct messages',
};
