import type { Bot } from '@calaba/protocol';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { CircleAlert, CircleCheck, CircleSlash, Copy, Ellipsis, ImageMinus, KeyRound, Plus, RefreshCw, Trash2, TriangleAlert, Upload, UserPlus } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { useImagePicker } from '../../components/AvatarPicker';
import { avatarFile } from '../../lib/image';
import { confirmAction } from '../../components/Confirm';
import { Button, Card, Empty, IconButton, Input, Modal, Row, Spinner, Tip, cx } from '../../components/ui';
import { plural, t } from '../../i18n';
import { errorText } from '../../lib/api/errors';
import { api } from '../../lib/api/endpoints';
import { botSlots, normalizeUsername, validBotUsername, webhookState } from '../../lib/bots';
import { fmt } from '../../lib/format';
import { botAvatarChanged, loadWorkspaceBots } from '../../services/bots';
import { openPlanContact, planContact, reportPlanError } from '../../services/plan';
import { useBots } from '../../stores/bots';
import { toast } from '../../stores/toasts';
import { useWorkspaces } from '../../stores/workspaces';
import { BotBadge } from '../people/MemberBits';
import { menuBox, menuItem, menuSeparator } from '../shell/menu';

/*
 * Workspace settings → «Боты» (ADR-0031 §7, docs/08 «Боты»), MANAGE_BOTS (ADR-0048): create a bot (its
 * token shown once), add a bot of another workspace by @username, the list with the webhook
 * state and per-bot «Перевыпустить токен» / «Отозвать токен» / «Удалить» (at home) or «Убрать из
 * пространства» (a bot added from elsewhere). The plan's bot limit is explained, not enforced.
 */

const err = (e: unknown): string => errorText(e);
const NO_BOTS: Bot[] = [];

/** A token just issued: shown once in the dialog, never stored anywhere else. */
interface Issued {
  name: string;
  token: string;
}

export function BotsTab({ workspaceId }: { workspaceId: string }): ReactNode {
  const bots = useBots((s) => s.byWorkspace[workspaceId] ?? NO_BOTS);
  const loaded = useBots((s) => workspaceId in s.byWorkspace);
  const limit = useWorkspaces((s) => s.byId[workspaceId]?.ws.plan?.limits?.bots ?? 0);
  const [issued, setIssued] = useState<Issued | null>(null);
  useEffect(() => {
    void loadWorkspaceBots(workspaceId);
  }, [workspaceId]);
  const slots = botSlots(bots.length, limit);
  const list = [...bots].sort((a, b) => (a.user?.displayName ?? '').localeCompare(b.user?.displayName ?? ''));
  return (
    <>
      <p className="text-caption text-muted">{t('bots.hint')}</p>
      {/* The bots first (what the tab is about), then how to get another one. */}
      {!loaded ? (
        <Spinner />
      ) : list.length === 0 ? (
        <Empty>{t('bots.none')}</Empty>
      ) : (
        <Card title={t('bots.listTitle', { n: list.length })}>
          {list.map((b) => (
            <BotRow key={b.user?.id} workspaceId={workspaceId} bot={b} onIssued={setIssued} />
          ))}
        </Card>
      )}
      {slots.limit > 0 ? <PlanLine used={slots.used} limit={slots.limit} full={slots.full} /> : null}
      <CreateCard workspaceId={workspaceId} full={slots.full} onIssued={setIssued} />
      <AddCard workspaceId={workspaceId} full={slots.full} />
      {issued ? <TokenDialog issued={issued} onClose={() => setIssued(null)} /> : null}
    </>
  );
}

/** «Ботов: 2 из 20 по тарифу»; at the limit — why «Создать» is off and whom to ask. */
function PlanLine({ used, limit, full }: { used: number; limit: number; full: boolean }): ReactNode {
  const contact = full && planContact();
  return (
    <div className={cx('-mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 px-1 text-caption', full ? 'text-muted' : 'text-faint')} data-testid="bots-plan">
      {full ? <TriangleAlert className="size-3.5 shrink-0 text-warn" aria-hidden /> : null}
      <span>{full ? plural('bots.planFull', limit) : t('bots.planUsage', { used, limit })}</span>
      {contact ? (
        <button type="button" className="font-medium text-accent-text hover:underline" onClick={openPlanContact}>
          {t('plan.contactShort')}
        </button>
      ) : null}
    </div>
  );
}

function CreateCard({ workspaceId, full, onIssued }: { workspaceId: string; full: boolean; onIssued: (i: Issued) => void }): ReactNode {
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uname = normalizeUsername(username);
  const ready = !!name.trim() && validBotUsername(uname) && !full;
  const create = async (): Promise<void> => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.bots.create(workspaceId, { displayName: name.trim(), username: uname, description: description.trim() });
      if (r.bot) useBots.getState().upsert(workspaceId, r.bot);
      onIssued({ name: r.bot?.user?.displayName ?? name.trim(), token: r.token });
      setName('');
      setUsername('');
      setDescription('');
    } catch (e) {
      if (!reportPlanError(e, workspaceId)) setError(err(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <Card title={t('bots.new')}>
        <Row label={t('bots.name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} placeholder={t('bots.namePlaceholder')} aria-label={t('bots.name')} className="w-60" data-testid="bot-name" />
        </Row>
        <Row label={t('bots.username')} hint={t('bots.usernameHint')}>
          <span className="relative flex w-60 items-center">
            <span className="pointer-events-none absolute left-2.5 text-body text-faint" aria-hidden>
              @
            </span>
            <Input
              value={username}
              onChange={(e) => setUsername(normalizeUsername(e.target.value))}
              maxLength={32}
              placeholder="weather_bot"
              aria-label={t('bots.username')}
              aria-invalid={username !== '' && !validBotUsername(uname)}
              className="w-full pl-6 font-mono"
              spellCheck={false}
              autoCapitalize="off"
              data-testid="bot-username"
            />
          </span>
        </Row>
        <Row label={t('bots.description')}>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={512} placeholder={t('bots.descriptionPlaceholder')} aria-label={t('bots.description')} className="w-60" />
        </Row>
        <div className="flex items-center justify-end gap-3 px-3 py-2.5">
          {error ? (
            <p role="alert" className="min-w-0 flex-1 text-caption text-danger-text">
              {error}
            </p>
          ) : null}
          <Button type="submit" busy={busy} disabled={!ready} data-testid="bot-create">
            <Plus className="size-4" aria-hidden /> {t('bots.create')}
          </Button>
        </div>
      </Card>
    </form>
  );
}

/** A bot of another workspace joins this one by its @username (Telegram-like; member role). */
function AddCard({ workspaceId, full }: { workspaceId: string; full: boolean }): ReactNode {
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uname = normalizeUsername(username);
  const add = async (): Promise<void> => {
    if (!validBotUsername(uname) || full) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.bots.add(workspaceId, { username: uname });
      if (r.bot) useBots.getState().upsert(workspaceId, r.bot);
      toast.success(t('bots.added', { name: r.bot?.user?.displayName ?? `@${uname}` }));
      setUsername('');
    } catch (e) {
      if (!reportPlanError(e, workspaceId)) setError(err(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={t('bots.addTitle')} footer={error ? undefined : t('bots.addHint')}>
      <form
        className="flex items-center gap-2 px-3 py-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <span className="relative flex min-w-0 flex-1 items-center">
          <span className="pointer-events-none absolute left-2.5 text-body text-faint" aria-hidden>
            @
          </span>
          <Input
            value={username}
            onChange={(e) => setUsername(normalizeUsername(e.target.value))}
            maxLength={32}
            placeholder="username"
            aria-label={t('bots.addUsername')}
            className="w-full pl-6 font-mono"
            spellCheck={false}
            autoCapitalize="off"
            data-testid="bot-add-username"
          />
        </span>
        <Button type="submit" variant="secondary" busy={busy} disabled={!validBotUsername(uname) || full} data-testid="bot-add">
          <UserPlus className="size-4" aria-hidden /> {t('bots.add')}
        </Button>
      </form>
      {error ? (
        <p role="alert" className="px-3 pb-2.5 text-caption text-danger-text">
          {error}
        </p>
      ) : null}
    </Card>
  );
}

function BotRow({ workspaceId, bot, onIssued }: { workspaceId: string; bot: Bot; onIssued: (i: Issued) => void }): ReactNode {
  const u = bot.user;
  const owner = useWorkspaces((s) => (bot.ownerUserId ? (s.users[bot.ownerUserId]?.displayName ?? '') : ''));
  // The avatar (docs/09 #87): the own profile's picker. The users store is the truth (USER_UPDATE
  // also follows a bot's own POST /api/me/avatar, which sends no BOT_UPDATE).
  const avatar = useWorkspaces((s) => s.users[bot.user?.id ?? '']?.avatarFileId ?? bot.user?.avatarFileId ?? '');
  const picker = useImagePicker((f) => {
    if (!u) return;
    avatarFile(f).then((a) => api.bots.setAvatar(workspaceId, u.id, a, a.name)).then(
      (r) => botAvatarChanged(workspaceId, r.bot),
      (e: unknown) => toast.fail(e, t('err.ctx.upload')),
    );
  });
  if (!u) return null;
  const home = bot.workspaceId === workspaceId;
  const revoked = !!bot.revokedAt;
  const name = u.displayName;
  const byline = [`@${bot.username}`, home ? (owner ? t('bots.ownerIs', { name: owner }) : '') : t('bots.foreign')].filter(Boolean).join(' · ');

  const run = async (f: () => Promise<void>): Promise<void> => {
    try {
      await f();
    } catch (e) {
      toast.fail(e);
    }
  };
  const reissue = async (): Promise<void> => {
    if (!(await confirmAction(t('bots.reissueTitle', { name }), t('bots.reissueText'), t('bots.reissue'), 'primary'))) return;
    await run(async () => {
      const r = await api.bots.reissue(workspaceId, u.id);
      if (r.bot) useBots.getState().upsert(workspaceId, r.bot);
      onIssued({ name, token: r.token });
    });
  };
  const revoke = async (): Promise<void> => {
    if (!(await confirmAction(t('bots.revokeTitle', { name }), t('bots.revokeText'), t('bots.revoke')))) return;
    await run(async () => {
      await api.bots.revoke(workspaceId, u.id);
      void loadWorkspaceBots(workspaceId); // revoked_at comes with BOT_UPDATE too; the list is the truth
    });
  };
  const clearAvatar = async (): Promise<void> => {
    await run(async () => {
      botAvatarChanged(workspaceId, (await api.bots.clearAvatar(workspaceId, u.id)).bot);
    });
  };
  const remove = async (): Promise<void> => {
    const ok = home
      ? await confirmAction(t('bots.deleteTitle', { name }), t('bots.deleteText'), t('bots.delete'))
      : await confirmAction(t('bots.removeTitle', { name }), t('bots.removeText'), t('bots.remove'));
    if (!ok) return;
    await run(async () => {
      await api.bots.remove(workspaceId, u.id);
      useBots.getState().remove(workspaceId, u.id);
    });
  };

  return (
    <div className="flex min-h-14 items-center gap-3 px-3 py-2" data-testid="bot-row">
      {home ? (
        <Tip label={t('bots.avatarChange', { name })}>
          <button type="button" className="shrink-0 rounded-full" aria-label={t('bots.avatarChange', { name })} onClick={picker.open} data-testid="bot-avatar">
            <Avatar userId={u.id} name={name} fileId={avatar || undefined} size={32} />
          </button>
        </Tip>
      ) : (
        <Avatar userId={u.id} name={name} fileId={avatar || undefined} size={32} />
      )}
      {home ? picker.input : null}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-body font-medium" title={name}>
            {name}
          </span>
          <BotBadge />
        </div>
        <div className="truncate text-caption text-muted mobile:line-clamp-2 mobile:whitespace-normal" title={byline}>
          {byline}
        </div>
        {home ? <BotStatus bot={bot} revoked={revoked} /> : null}
      </div>
      <Dropdown.Root modal={false}>
        <Tip label={t('bots.actions', { name })}>
          <Dropdown.Trigger asChild>
            <IconButton tip={false} label={t('bots.actions', { name })} data-testid="bot-actions" className="mobile:size-11">
              <Ellipsis className="size-4" />
            </IconButton>
          </Dropdown.Trigger>
        </Tip>
        <Dropdown.Portal>
          <Dropdown.Content align="end" sideOffset={6} collisionPadding={16} className={menuBox}>
            {home ? (
              <>
                <Dropdown.Item className={menuItem} onSelect={() => void reissue()}>
                  <RefreshCw className="size-4" aria-hidden /> {t('bots.reissue')}
                </Dropdown.Item>
                <Dropdown.Item className={menuItem} disabled={revoked} onSelect={() => void revoke()}>
                  <KeyRound className="size-4" aria-hidden /> {t('bots.revoke')}
                </Dropdown.Item>
                <Dropdown.Separator className={menuSeparator} />
                <Dropdown.Item className={menuItem} onSelect={picker.open} data-testid="bot-avatar-upload">
                  <Upload className="size-4" aria-hidden /> {t('profile.avatar')}
                </Dropdown.Item>
                {avatar ? (
                  <Dropdown.Item className={menuItem} onSelect={() => void clearAvatar()} data-testid="bot-avatar-remove">
                    <ImageMinus className="size-4" aria-hidden /> {t('bots.avatarRemove')}
                  </Dropdown.Item>
                ) : null}
                <Dropdown.Separator className={menuSeparator} />
                <Dropdown.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void remove()}>
                  <Trash2 className="size-4" aria-hidden /> {t('common.delete')}
                </Dropdown.Item>
              </>
            ) : (
              <Dropdown.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void remove()}>
                <Trash2 className="size-4" aria-hidden /> {t('bots.remove')}
              </Dropdown.Item>
            )}
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
    </div>
  );
}

/** Third line of a home bot: the token, then how its webhook is doing. */
function BotStatus({ bot, revoked }: { bot: Bot; revoked: boolean }): ReactNode {
  if (revoked) {
    return (
      <Line icon={<CircleSlash className="size-3.5 shrink-0" aria-hidden />} tone="warn">
        {t('bots.revoked', { date: bot.revokedAt ? fmt.stamp(timestampDate(bot.revokedAt)) : '' })}
      </Line>
    );
  }
  const w = webhookState(bot.webhook);
  switch (w.kind) {
    case 'none':
      return <Line tone="faint">{t('bots.webhookNone')}</Line>;
    case 'ok':
      return (
        <Line icon={<CircleCheck className="size-3.5 shrink-0" aria-hidden />} tone="ok">
          {w.lastOk ? t('bots.webhookOk', { date: fmt.stamp(w.lastOk) }) : t('bots.webhookWaiting')}
          {w.pending ? ` · ${plural('bots.webhookPending', w.pending, { n: w.pending })}` : ''}
        </Line>
      );
    case 'failing':
      return (
        <Line icon={<CircleAlert className="size-3.5 shrink-0" aria-hidden />} tone="danger" title={w.error}>
          {t('bots.webhookFailing', { date: fmt.stamp(w.since) })}
          {w.error ? ` · ${w.error}` : ''}
          {w.pending ? ` · ${plural('bots.webhookPending', w.pending, { n: w.pending })}` : ''}
        </Line>
      );
    case 'disabled':
      return (
        <Line icon={<TriangleAlert className="size-3.5 shrink-0" aria-hidden />} tone="danger" title={w.error}>
          {t('bots.webhookDisabled', { date: w.at ? fmt.stamp(w.at) : '' })}
        </Line>
      );
  }
}

function Line({ icon, tone, title, children }: { icon?: ReactNode; tone: 'ok' | 'danger' | 'warn' | 'faint'; title?: string | undefined; children: ReactNode }): ReactNode {
  // Text colours ≥ 4.5:1 on the card in both themes; the yellow is the icon's only.
  const color = tone === 'ok' ? 'text-[var(--color-green-text)]' : tone === 'danger' ? 'text-danger-text' : tone === 'warn' ? 'text-muted [&>svg]:text-warn' : 'text-faint';
  return (
    <div className={cx('flex min-w-0 items-center gap-1 text-caption mobile:items-start', color)} title={title} data-testid="bot-status">
      {icon}
      <span className="truncate mobile:line-clamp-2 mobile:whitespace-normal mobile:break-words">{children}</span>
    </div>
  );
}

/**
 * The token, once (ADR-0031 §2): a read-only field with «Копировать» and the warning that it is
 * not shown again; «Перевыпустить» later brings the same dialog with a new one.
 */
function TokenDialog({ issued, onClose }: { issued: Issued; onClose: () => void }): ReactNode {
  const copyButton = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard.writeText(issued.token).then(
      () => {
        setCopied(true);
        toast.success(t('bots.tokenCopied'));
      },
      (e: unknown) => toast.fail(e),
    );
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={t('bots.tokenTitle', { name: issued.name })}
      initialFocus={copyButton}
      footer={
        <Button onClick={onClose} data-testid="bot-token-done">
          {t('bots.tokenDone')}
        </Button>
      }
    >
      <div className="flex flex-col gap-3" data-testid="bot-token-dialog">
        <div className="flex items-start gap-2 rounded-[var(--radius-card)] bg-[var(--color-mention)] px-3 py-2.5 text-body">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
          <span>{t('bots.tokenOnce')}</span>
        </div>
        {/* The whole token, wrapped (a one-line field shows only a part of its ~90 characters). */}
        <textarea
          readOnly
          rows={3}
          value={issued.token}
          aria-label={t('bots.token')}
          spellCheck={false}
          className="selectable w-full resize-none break-all rounded-[var(--radius-card)] border border-line bg-[var(--color-code)] px-2.5 py-2 font-mono text-caption leading-[18px]"
          onFocus={(e) => e.currentTarget.select()}
          data-testid="bot-token"
        />
        <div className="flex justify-end">
          <Button ref={copyButton} variant={copied ? 'secondary' : 'primary'} onClick={copy} data-testid="bot-token-copy">
            <Copy className="size-4" aria-hidden /> {copied ? t('bots.tokenCopiedShort') : t('bots.tokenCopy')}
          </Button>
        </div>
        <p className="text-caption text-muted">{t('bots.tokenUse')}</p>
      </div>
    </Modal>
  );
}
