import { applyIdentityAccess } from '../../services/identity';
import { slugError } from './slugError';
import { WorkspaceVisibility } from '@calaba/protocol';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Button, Field, Input, Modal, Select, Spinner } from '../../components/ui';
import { t } from '../../i18n';
import { workspaceInitials } from '../../lib/initials';
import { ApiError } from '../../lib/api/client';
import { errorText } from '../../lib/api/errors';
import { api } from '../../lib/api/endpoints';
import { offerPlansAfterCreate } from '../../services/billing';
import { joinPlaceholder, parseInviteCode, parseRoomInviteCode } from '../../services/links';
import { RoomLinkPreview } from '../people/RoomLinkPreview';
import { useSession } from '../../stores/session';
import { useUi } from '../../stores/ui';

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n',
  о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ы: 'y', э: 'e',
  ю: 'yu', я: 'ya', ь: '', ъ: '',
};

/** Slug per server rules: 3..32 chars, [a-z0-9-], no leading/trailing/double '-'. */
export function slugify(name: string): string {
  const s = Array.from(name.toLowerCase())
    .map((ch) => TRANSLIT[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  // Deterministic (it is recomputed on every keystroke): pad short slugs, never invent random ones.
  if (s.length >= 3) return s;
  if (s) return `${s}-ws`;
  return name.trim() ? 'workspace' : '';
}

function errText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.is('ERROR_CODE_CONFLICT')) return t('ws.slugTaken');
    if (e.is('ERROR_CODE_INVITE_INVALID') || e.is('ERROR_CODE_NOT_FOUND')) return t('ws.inviteInvalid');
    // An emailed invitation (docs/09 #36): bound to its address, joined once it is confirmed.
    if (e.is('ERROR_CODE_INVITE_EMAIL_MISMATCH')) return t('mail.inv.emailMismatch');
    if (e.is('ERROR_CODE_EMAIL_NOT_VERIFIED')) return t('mail.inv.verifyFirst');
  }
  return errorText(e);
}

/**
 * Joining by an invitation link or code (the join dialog and the onboarding's join step): the
 * public preview, then POST /api/invites/{code}/join — a link's code or an emailed one (for the
 * account's own address). An existing member gets the membership back: the workspace opens.
 */
export function useInviteJoin(input: string, onJoined: () => void) {
  const code = parseInviteCode(input);
  const setWs = useUi((s) => s.setWorkspace);
  const preview = useQuery({ queryKey: ['invite', code], queryFn: () => api.invites.get(code ?? ''), enabled: !!code, retry: false });
  const join = useMutation({
    mutationFn: (arg: { code?: string; id?: string }) => (arg.code ? api.invites.join(arg.code) : api.workspaces.joinOpen(arg.id ?? '')),
    onSuccess: (r) => {
      if (r.identityAccess) {
        applyIdentityAccess(r.identityAccess);
        setWs(r.identityAccess.workspaceId);
      } else if (r.workspace) setWs(r.workspace.id);
      onJoined();
    },
  });
  // Enabled only for a well-formed invite (parseInviteCode) that the server resolved to a workspace.
  const canJoin =
    !!code && (!!preview.data?.workspace || (preview.error instanceof ApiError && preview.error.is('ERROR_CODE_SSO_REQUIRED')));
  const error = preview.error ? errText(preview.error) : join.error ? errText(join.error) : null;
  return { code, preview, join, canJoin, error };
}

/** The workspace an invitation leads to (initials + name), or a spinner while it loads. */
export function InvitePreviewRow({ preview }: { preview: ReturnType<typeof useInviteJoin>['preview'] }): ReactNode {
  if (preview.data?.workspace)
    return (
      <div className="flex items-center gap-3 rounded-[var(--radius-card)] bg-[var(--color-card)] px-3 py-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-[var(--radius-card)] bg-accent-strong text-caption font-semibold text-accent-fg" aria-hidden>
          {workspaceInitials(preview.data.workspace.name)}
        </span>
        <span className="min-w-0 truncate font-semibold" title={preview.data.workspace.name}>
          {preview.data.workspace.name}
        </span>
      </div>
    );
  return preview.isFetching ? <Spinner /> : null;
}

export function CreateWorkspaceDialog({ onClose }: { onClose: () => void }): ReactNode {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [visibility, setVisibility] = useState(WorkspaceVisibility.PRIVATE);
  const setWs = useUi((s) => s.setWorkspace);
  const effectiveSlug = slugTouched ? slug : slugify(name);
  const slugErr = effectiveSlug ? slugError(effectiveSlug) : null;
  const m = useMutation({
    mutationFn: () => api.workspaces.create({ name: name.trim(), slug: effectiveSlug, visibility }),
    onSuccess: (r) => {
      if (r.workspace) setWs(r.workspace.id);
      onClose();
      // ADR-0080: the plan choice right after creating, when it can be paid for here (never blocks).
      if (r.workspace) void offerPlansAfterCreate(r.workspace.id);
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={t('ws.createTitle')}
      description={t('ws.createText')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button busy={m.isPending} disabled={!name.trim() || !!slugErr} onClick={() => m.mutate()}>
            {t('common.create')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={t('ws.name')}>
          <Input autoFocus value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('ws.slug')} hint={t('ws.slugHint')} error={slugErr ?? (m.error ? errText(m.error) : null)}>
          <Input
            value={effectiveSlug}
            placeholder="komanda"
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value.toLowerCase());
            }}
            spellCheck={false}
          />
        </Field>
        <Field label={t('ws.visibility')}>
          <Select value={visibility} onChange={(e) => setVisibility(Number(e.target.value))}>
            <option value={WorkspaceVisibility.PRIVATE}>{t('ws.private')}</option>
            <option value={WorkspaceVisibility.OPEN}>{t('ws.open')}</option>
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

export function JoinWorkspaceDialog({ onClose, initialCode }: { onClose: () => void; initialCode: string }): ReactNode {
  const [input, setInput] = useState(initialCode);
  const roomCode = parseRoomInviteCode(input);
  const serverUrl = useSession((s) => s.serverUrl);
  const { code, preview, join, canJoin, error } = useInviteJoin(input, onClose);
  const discover = useQuery({ queryKey: ['discover'], queryFn: () => api.workspaces.discover() });

  return (
    <Modal
      open
      onClose={onClose}
      title={t('ws.joinTitle')}
      description={t('ws.joinText')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button busy={join.isPending && !join.variables.id} disabled={!canJoin} onClick={() => join.mutate({ code: code ?? '' })}>
            {t('ws.join')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label={t('ws.inviteCode')} error={error}>
          <Input
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canJoin) join.mutate({ code: code ?? '' });
            }}
            placeholder={joinPlaceholder(serverUrl)}
            spellCheck={false}
          />
        </Field>
        {roomCode ? <RoomLinkPreview code={roomCode} onDone={onClose} /> : null}
        <InvitePreviewRow preview={preview} />
        {/* Only when there is something to offer: no header, empty text or spinner otherwise. */}
        {discover.data?.workspaces.length ? <h3 className="mt-3 text-caption font-semibold text-muted">{t('ws.discover')}</h3> : null}
        {discover.data?.workspaces.map((w) => (
          <div key={w.id} className="flex items-center justify-between gap-3 rounded-[var(--radius-card)] bg-[var(--color-card)] px-3 py-2">
            <span className="min-w-0 truncate" title={w.name}>
              {w.name}
            </span>
            <Button size="sm" variant="secondary" busy={join.isPending && join.variables.id === w.id} onClick={() => join.mutate({ id: w.id })}>
              {t('ws.joinBtn')}
            </Button>
          </div>
        ))}
      </div>
    </Modal>
  );
}
