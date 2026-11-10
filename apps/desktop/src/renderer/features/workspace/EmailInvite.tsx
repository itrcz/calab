import { WorkspaceRole, type Role } from '@calaba/protocol';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { confirmAction } from '../../components/Confirm';
import { Avatar } from '../../components/Avatar';
import { Badge, Button, Card, IconButton, Input, Select, Spinner } from '../../components/ui';
import { plural, t } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { errorText } from '../../lib/api/errors';
import { api } from '../../lib/api/endpoints';
import { fmt } from '../../lib/format';
import { planErrorNotice, planKind } from '../../lib/plan';
import { inviteRoleChoices, roleActor } from '../../lib/roles';
import { useSession } from '../../stores/session';
import { roleName } from '../people/MemberBits';
import { RoleChipList, rolePickItem } from '../people/RoleChipList';
import { workspacePlan } from '../../services/plan';
import { toast } from '../../stores/toasts';
import { useMemberRoles, useWorkspaces } from '../../stores/workspaces';
import { EmailLookup, type LookupState } from './emailLookup';

/** A failed add / invitation: 429 of «the same address < 24 h ago» names the wait; the plan's members limit its own text. */
function sendError(e: unknown, workspaceId: string): string {
  const plan = planErrorNotice(e, planKind(workspacePlan(workspaceId)));
  if (plan) return plan.text;
  if (e instanceof ApiError) {
    if (e.status === 409) return t('mail.invite.already');
    if (e.status === 429) {
      const h = Math.max(1, Math.ceil((e.retryAfter ?? 3600) / 3600));
      return e.retryAfter && e.retryAfter > 3600 ? plural('mail.invite.again', h) : t('mail.err.rate');
    }
  }
  return errorText(e);
}

const NO_ROLES: readonly Role[] = [];

/** The workspace's roles (a store array: a stable selector result). */
function useWorkspaceRoles(workspaceId: string): readonly Role[] {
  return useWorkspaces((s) => s.byId[workspaceId]?.roles ?? NO_ROLES);
}

/** «Роли: …» of an invitation in the lists: the names of its roles still known, '' for none. */
export function useInviteRoleNames(workspaceId: string, ids: readonly string[]): string {
  const all = useWorkspaceRoles(workspaceId);
  if (!ids.length) return '';
  const names = all.filter((r) => ids.includes(r.id)).map(roleName);
  return names.length ? `${t('invite.roles')}: ${names.join(', ')}` : '';
}

/** The roles I may put into an invitation (lib/roles inviteRoleChoices = server inviteRoles). */
export function useInviteRoleChoices(workspaceId: string): Role[] {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const mine = useMemberRoles(workspaceId, me);
  const all = useWorkspaceRoles(workspaceId);
  return useMemo(() => inviteRoleChoices(roleActor(mine), all), [mine, all]);
}

/**
 * The custom roles an invitation gives on joining (CBF-174): chips and «+» offering `choices`
 * (useInviteRoleChoices; the caller hides the whole line when there are none).
 */
export function InviteRoles({ choices, value, onChange, className }: { choices: readonly Role[]; value: readonly string[]; onChange: (ids: string[]) => void; className?: string }): ReactNode {
  return (
    <RoleChipList
      roles={choices.filter((r) => value.includes(r.id))}
      removable={() => true}
      onRemove={(r) => onChange(value.filter((id) => id !== r.id))}
      items={choices.filter((r) => !value.includes(r.id)).map((r) => rolePickItem(r))}
      onPick={(item) => onChange([...value, item.roleId])}
      pickerTestId="invite-role-picker"
      className={className}
    />
  );
}

/**
 * «Пригласить по email» (ADR-0023, docs/08 «Почта»), on top of the invitations tab: an exact
 * address → the account's card with «Добавить» (a member at once), or «Отправить приглашение на
 * почту» (a single-use link for 7 days, bound to the address). Below — the pending invitations
 * with «Отозвать». The links by code stay as they are. «Роли» (CBF-174): custom roles for both
 * the added account and the invitation; kept after sending (several people, same roles).
 */
export function EmailInviteCard({ workspaceId, full = false }: { workspaceId: string; full?: boolean }): ReactNode {
  const owner = useWorkspaces((s) => s.byId[workspaceId]?.role === WorkspaceRole.OWNER);
  const qc = useQueryClient();
  const [value, setValue] = useState('');
  const [role, setRole] = useState(WorkspaceRole.MEMBER);
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [state, setState] = useState<LookupState>({ kind: 'idle' });
  const [blurred, setBlurred] = useState(false);
  const [lookup] = useState(() => new EmailLookup({ lookup: (email, signal) => api.workspaces.lookupInvitee(workspaceId, email, signal), onChange: setState }));
  useEffect(() => () => lookup.dispose(), [lookup]);

  const reset = (): void => {
    setValue('');
    lookup.input('');
  };
  const add = useMutation({
    mutationFn: (userId: string) => api.workspaces.addMember(workspaceId, userId, roleIds),
    onSuccess: (r) => {
      if (r.member) useWorkspaces.getState().upsertMember(r.member);
      toast.success(t('mail.invite.added', { name: r.member?.user?.displayName ?? '' }));
      reset();
    },
  });
  const invite = useMutation({
    mutationFn: (email: string) => api.workspaces.createEmailInvite(workspaceId, email, owner ? role : undefined, roleIds),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['email-invites', workspaceId] });
      toast.success(t('mail.invite.sent', { email: r.invite?.email ?? '' }));
      reset();
    },
  });
  const failure = add.error ?? invite.error;

  return (
    <Card title={t('mail.invite.title')} footer={t('mail.invite.hint')}>
      <div className="flex flex-col gap-3 px-3 py-3" data-testid="invite-email">
        <label className="flex items-center">
          <Input
            type="email"
            aria-label={t('mail.invite.field')}
            placeholder={t('mail.invite.placeholder')}
            autoComplete="off"
            spellCheck={false}
            value={value}
            onBlur={() => setBlurred(true)}
            onChange={(e) => {
              setValue(e.target.value);
              add.reset();
              invite.reset();
              lookup.input(e.target.value);
            }}
            icon={<Mail className="size-3.5" />}
          />
        </label>
        <InviteRolesLine workspaceId={workspaceId} value={roleIds} onChange={setRoleIds} />
        <div aria-live="polite" className="empty:hidden">
          {state.kind === 'searching' ? (
            <div className="flex min-h-10 items-center gap-2 text-caption text-muted">
              <Spinner className="size-4" />
              {t('mail.invite.searching')}
            </div>
          ) : null}
          {state.kind === 'found' ? (
            <div className="flex min-h-12 items-center gap-3 rounded-[var(--radius-card)] border border-line px-3 py-2" data-testid="invite-email-found">
              <Avatar userId={state.user.id} name={state.user.displayName} fileId={state.user.avatarFileId || undefined} size={32} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-body font-medium" title={state.user.displayName}>
                  {state.user.displayName}
                </div>
                <div className="truncate text-caption text-muted">{state.email}</div>
              </div>
              {state.member ? (
                <Badge>{t('mail.invite.member')}</Badge>
              ) : (
                <Button busy={add.isPending} disabled={full} onClick={() => add.mutate(state.user.id)}>
                  {t('mail.invite.add')}
                </Button>
              )}
            </div>
          ) : null}
          {state.kind === 'none' ? (
            <div className="flex flex-wrap items-center gap-2" data-testid="invite-email-none">
              <p className="min-w-0 flex-1 basis-48 text-caption text-muted">{t('mail.invite.none', { email: state.email })}</p>
              {owner ? (
                <Select aria-label={t('mail.invite.role')} className="w-40" value={role} onChange={(e) => setRole(Number(e.target.value))}>
                  <option value={WorkspaceRole.MEMBER}>{t('role.member')}</option>
                  <option value={WorkspaceRole.ADMIN}>{t('role.admin')}</option>
                </Select>
              ) : null}
              <Button busy={invite.isPending} disabled={full} onClick={() => invite.mutate(state.email)}>
                {t('mail.invite.send')}
              </Button>
            </div>
          ) : null}
          {state.kind === 'typing' && (blurred || value.includes('@')) ? (
            <p className="text-caption text-danger-text" role="alert" data-testid="invite-email-bad">
              {t('mail.invite.bad')}
            </p>
          ) : null}
          {state.kind === 'error' ? (
            <p className="text-caption text-danger-text" role="alert">
              {state.text}
            </p>
          ) : null}
          {failure ? (
            <p className="mt-2 text-caption text-danger-text" role="alert">
              {sendError(failure, workspaceId)}
            </p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

/** «Отправленные приглашения»: pending email invitations, newest first, with «Отозвать». */
export function EmailInvitesList({ workspaceId }: { workspaceId: string }): ReactNode {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['email-invites', workspaceId], queryFn: () => api.workspaces.emailInvites(workspaceId) });
  const revoke = useMutation({
    mutationFn: (id: string) => api.workspaces.revokeEmailInvite(workspaceId, id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['email-invites', workspaceId] });
      toast.success(t('mail.invite.revoked'));
    },
    onError: (e) => toast.fail(e),
  });
  const invites = q.data?.invites ?? [];
  if (!invites.length) return null;
  return (
    <Card title={t('mail.invite.pending')}>
      {invites.map((i) => (
        <div key={i.id} className="flex min-h-10 items-center gap-3 px-3 py-2">
          <span className="selectable min-w-0 flex-1 truncate text-body" title={i.email}>
            {i.email}
          </span>
          <PendingMeta workspaceId={workspaceId} admin={i.role === WorkspaceRole.ADMIN} roleIds={i.roleIds} until={i.expiresAt ? fmt.shortDate(timestampDate(i.expiresAt)) : ''} />
          <IconButton label={`${t('mail.invite.revoke')}: ${i.email}`} className="text-muted hover:text-danger" onClick={() =>
              void confirmAction(t('mail.invite.revokeTitle'), t('mail.invite.revokeText', { email: i.email }), t('mail.invite.revoke')).then((ok) => ok && revoke.mutate(i.id))
            }
          >
            <Trash2 className="size-4" />
          </IconButton>
        </div>
      ))}
    </Card>
  );
}

/** «Роли» line of the email card: the label and the chips; nothing when I may give no role. */
function InviteRolesLine({ workspaceId, value, onChange }: { workspaceId: string; value: readonly string[]; onChange: (ids: string[]) => void }): ReactNode {
  const choices = useInviteRoleChoices(workspaceId);
  if (!choices.length) return null;
  return (
    <div className="flex min-h-7 items-center gap-3" data-testid="invite-email-roles">
      <span className="shrink-0 text-caption text-muted">{t('invite.roles')}</span>
      <InviteRoles choices={choices} value={value} onChange={onChange} className="min-w-0 flex-1" />
    </div>
  );
}

/** «Участник · Роли: … · до …» of a pending invitation (max-w: a long list of roles truncates). */
function PendingMeta({ workspaceId, admin, roleIds, until }: { workspaceId: string; admin: boolean; roleIds: readonly string[]; until: string }): ReactNode {
  const roles = useInviteRoleNames(workspaceId, roleIds);
  const text = [admin ? t('role.admin') : t('role.member'), roles, until ? t('mail.invite.until', { date: until }) : ''].filter(Boolean).join(' · ');
  return (
    <span className="min-w-0 max-w-[60%] shrink truncate text-caption text-faint" title={text}>
      {text}
    </span>
  );
}
