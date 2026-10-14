import type { ruContacts } from '../ru/contacts';
import type { DictShape } from '../types';

/** English UI strings — contacts and nickname in the profile (ADR-0077). Same keys as ru/contacts.ts. */
export const enContacts: DictShape<typeof ruContacts> = {
  'people.contacts.title': 'Contacts',
  'people.contacts.email': 'Email',
  'people.contacts.phone': 'Phone',
  'people.contacts.unverified': 'not verified',
  'people.contacts.copyWhat': 'Copy: {what}',
  'people.contacts.copied': 'Copied',
  'people.contacts.copyFailed': 'Couldn’t copy',
  'profile.username': 'Username',
  'profile.username.hint': 'For @mentions, one across all workspaces',
  'profile.username.placeholder': 'ivan_petrov',
  'profile.username.checking': 'Checking…',
  'profile.username.free': 'Username is available',
  'profile.username.taken': 'This username is taken',
  'profile.username.invalid': '3 to 32 Latin letters, digits and _, starting with a letter',
  'profile.username.reserved': 'This username is reserved',
  'profile.phone': 'Phone',
  'profile.phone.hint': 'Visible to your workspace colleagues, not verified',
  'profile.phone.placeholder': '+1 555 123-4567',
  'profile.phone.invalid': 'Digits, +, spaces, brackets and hyphens only, up to 32 characters',
};
