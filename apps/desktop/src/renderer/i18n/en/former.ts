import type { ruFormer } from '../ru/former';
import type { DictShape } from '../types';

/** UI strings — former members and guests (ADR-0097, ADR-0098). */
export const enFormer: DictShape<typeof ruFormer> = {
  'former.chip': 'former',
  'former.since': 'Left {date}',
  'former.profile': 'Former member · {what} {date}',
  'former.profileNoDate': 'Former member',
  'former.reason.left': 'left',
  'former.reason.removed': 'removed',
  'former.reason.banned': 'banned',
  'former.reason.guestExpired': 'guest access expired',
  'former.reason.directory': 'disabled in the directory',
  'former.tab': 'Former',
  'former.card': 'Former members — {n}',
  'former.none': 'No former members',
  'former.search': 'Search by name',
  'former.showGuests': 'Show guests',
  'former.guestsHint': 'Guests with no activity are removed after 48 h',
  'former.openTasks': 'Open tasks: {n}',
  'former.openTasksOpen': 'Open tasks: {n}',
  'former.invite': 'Invite again',
  'former.inviteFor': 'Invite {name} again',
  'former.more': 'Show more',
  'former.by': 'by {who}',
  'former.reassign': 'Reassign',
  'former.filter': 'Assignee: former members',
  'former.filterValue': 'Former members',
  'former.guestsGroup': 'Guests · {n}',
  'former.seen': 'seen {when}',
  'former.noActions': 'Your direct messages with them stay in Direct',
};
