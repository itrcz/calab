import { WorkspaceRole, type Role, type User, type WorkspaceMember } from '@calaba/protocol';
import { customLook, rolesOfMember } from '../../lib/roles';
import { getLocale } from '../../i18n';
import { haystackOf, matchHaystack, type Match, type ParsedQuery } from '../../lib/memberSearch';
import type { PickerItem } from '../../components/picker/pickerModel';
import { nameOf, roleRank } from './members';

/*
 * Items of the member picker (docs/08 «Выбор участника»): workspace members and roles. Pure —
 * the rows (MemberPicker.tsx) read presence and avatars from the stores themselves.
 */

export interface MemberPickItem extends PickerItem {
  kind: 'member';
  userId: string;
  /** Workspace nickname, else the profile name. */
  name: string;
  /** Muted second part: the profile name when a nickname is shown, or the email when known. */
  secondary: string;
  avatarFileId: string;
  role: WorkspaceRole | undefined;
  /** The custom role colouring the name (ADR-0026; none for owner / admins). */
  custom?: Role | undefined;
  guest: boolean;
  /** Muted note at the end of the row («полный доступ», «в списке»). */
  note: string;
}

export interface RolePickItem extends PickerItem {
  kind: 'role';
  /** Built-in kind (UNSPECIFIED = a custom role, ADR-0026). */
  role: WorkspaceRole;
  /** Role id (a room override target, PUT …/members/{uid}/roles). */
  roleId: string;
  /** 0xRRGGBB, 0 = none (custom roles show a dot in it). */
  color: number;
  label: string;
  note: string;
}

/** Searchable fields of a member (names / contacts), the same arrays for the same member object (cached haystack). */
const termsCache = new WeakMap<WorkspaceMember, { search: string[]; hidden: string[] }>();
export function memberTerms(m: WorkspaceMember, knownEmail = ''): { search: string[]; hidden: string[] } {
  if (!knownEmail) {
    const hit = termsCache.get(m);
    if (hit) return hit;
  }
  const u = m.user;
  // Only what the server sent this viewer: contacts are empty where they must not be seen (ADR-0077).
  const terms = {
    search: [m.nickname, u?.displayName ?? '', u?.username ?? ''].filter(Boolean),
    hidden: [u?.email || knownEmail, u?.phone ?? '', m.extension].filter(Boolean),
  };
  if (!knownEmail) termsCache.set(m, terms);
  return terms;
}

/** `search` / `searchHidden` of a member by id for pickers that build their own rows (task assignee menus). */
export function searchOf(members: Readonly<Record<string, WorkspaceMember>> | undefined, userId: string, extra: readonly string[] = []): { search: string[]; searchHidden: string[] } {
  const m = members?.[userId];
  if (!m) return { search: [...extra], searchHidden: [] };
  const t = memberTerms(m);
  return { search: extra.length ? [...t.search, ...extra] : t.search, searchHidden: t.hidden };
}

/** Whether a member matches a parsed query (names, username, email, phone, extension). */
export function matchMember(m: WorkspaceMember, q: ParsedQuery): Match | null {
  const t = memberTerms(m);
  return matchHaystack(haystackOf(t.search, t.hidden), q);
}

export type PeoplePickItem = MemberPickItem | RolePickItem;

export interface MemberItemOpts {
  /** User ids left out entirely. */
  exclude?: ReadonlySet<string>;
  /** Note / disabled per member (e.g. owner and admins: «полный доступ», not choosable). */
  decorate?: (m: WorkspaceMember) => { note?: string; disabled?: boolean } | undefined;
  /** Emails by user id, where the caller knows them (the server does not send others' emails). */
  emails?: Readonly<Record<string, string>>;
  /** Workspace roles (ADR-0026): names coloured by the member's custom role. */
  roles?: readonly Role[];
}

/** Workspace members → picker items: owner → admins → members → guests, then by name. */
export function memberItems(members: readonly WorkspaceMember[], opts: MemberItemOpts = {}): MemberPickItem[] {
  const list = members.filter((m) => m.user && !opts.exclude?.has(m.user.id));
  list.sort((a, b) => roleRank(a.role) - roleRank(b.role) || nameOf(a).localeCompare(nameOf(b), getLocale()));
  return list.map((m) => {
    const u = m.user as User;
    const name = nameOf(m) || u.id;
    const email = opts.emails?.[u.id] ?? '';
    const secondary = m.nickname && m.nickname !== u.displayName ? u.displayName : email;
    const extra = opts.decorate?.(m);
    const terms = memberTerms(m, email);
    return {
      kind: 'member',
      id: u.id,
      userId: u.id,
      name,
      secondary,
      avatarFileId: u.avatarFileId,
      role: m.role,
      custom: opts.roles ? customLook(rolesOfMember(opts.roles, m)) : undefined,
      guest: m.role === WorkspaceRole.GUEST,
      note: extra?.note ?? '',
      search: terms.search,
      searchHidden: terms.hidden,
      ...(extra?.disabled ? { disabled: true } : {}),
    };
  });
}

/** Users from a server search (new DM candidates) → items; `roleOf` gives the most senior shared role. */
export function userItems(users: readonly User[], roleOf: (userId: string) => WorkspaceRole | undefined = () => undefined): MemberPickItem[] {
  return users.map((u) => ({
    kind: 'member',
    id: u.id,
    userId: u.id,
    name: u.displayName,
    secondary: '',
    avatarFileId: u.avatarFileId,
    role: roleOf(u.id),
    guest: u.isGuest,
    note: '',
    search: [u.displayName],
  }));
}

/**
 * Permanent members vs guest accounts (ADR-0040): the room permissions list shows guests apart
 * (a collapsed «Гости · N» group) so they don't clutter the member list. Order is kept.
 */
export function splitGuests<T extends { guest: boolean }>(items: readonly T[]): { members: T[]; guests: T[] } {
  const members: T[] = [];
  const guests: T[] = [];
  for (const i of items) (i.guest ? guests : members).push(i);
  return { members, guests };
}
