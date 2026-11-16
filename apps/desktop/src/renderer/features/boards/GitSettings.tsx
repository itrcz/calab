import { timestampDate } from '@bufbuild/protobuf/wkt';
import { GitProvider, type Board, type BoardGit } from '@calaba/protocol';
import { Copy, Dices, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { confirmAction } from '../../components/Confirm';
import { PlanLock } from '../../components/PlanLock';
import { Button, Card, Input, PasswordInput, Row, Select, Spinner, Switch, Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { GIT_PROVIDERS, GIT_STEPS, GIT_STEPS_COMMON, generateGitSecret, gitHookUrl, type GitStep } from '../../lib/boards/git';
import { fmt } from '../../lib/format';
import { planHas } from '../../lib/plan';
import { deleteGit, loadGit, saveBacklink, saveGit } from '../../services/automations';
import { copyText } from '../../services/boards';
import { useSession } from '../../stores/session';
import { memberName, useWorkspaces } from '../../stores/workspaces';
import { asEnum } from '../../lib/enums';

/**
 * Board settings → «Git» (ADR-0060 §4): the provider (GitHub / GitLab / Gitea-Forgejo), the
 * secret (own, «Сгенерировать» in the client, or empty — the server generates it and shows it
 * once, with «Скопировать»), the webhook address (known before saving: it is deterministic) with
 * «Скопировать», a numbered guide per provider with inline copy buttons, the status (last event,
 * count, last error), «Отключить». MANAGE_BOARD + MANAGE_INTEGRATIONS (the tab is hidden
 * otherwise); Team and above — below it the form is locked.
 */
export function GitTab({ board }: { board: Board }): ReactNode {
  const allowed = useWorkspaces((s) => planHas(s.byId[board.workspaceId]?.ws.plan, 'automations'));
  const [git, setGit] = useState<BoardGit | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [provider, setProvider] = useState<GitProvider>(GitProvider.GITHUB);
  const [secret, setSecret] = useState('');
  const [shown, setShown] = useState('');
  const [busy, setBusy] = useState(false);
  const serverUrl = useSession((s) => s.serverUrl);
  useEffect(() => {
    const ac = new AbortController();
    loadGit(board.id, ac.signal).then(
      (g) => {
        setGit(g);
        if (g?.provider) setProvider(g.provider);
        setState('ready');
      },
      () => !ac.signal.aborted && setState('error'),
    );
    return () => ac.abort();
  }, [board.id]);
  if (state === 'loading') {
    return (
      <div className="grid h-24 place-items-center">
        <Spinner />
      </div>
    );
  }
  if (state === 'error') return <p className="px-1 text-body text-danger-text">{t('git.loadFailed')}</p>;
  const save = async (): Promise<void> => {
    setBusy(true);
    const r = await saveGit(board.workspaceId, board.id, provider, secret.trim());
    setBusy(false);
    if (!r) return;
    setGit(r.git);
    setSecret('');
    setShown(r.secret);
  };
  const remove = async (): Promise<void> => {
    if (!(await confirmAction(t('git.deleteTitle'), t('git.deleteText'), t('git.delete')))) return;
    if (await deleteGit(board.workspaceId, board.id)) {
      setGit(null);
      setShown('');
    }
  };
  const secretOk = secret.trim() === '' || (secret.trim().length >= 16 && secret.trim().length <= 256);
  const url = git && git.provider === provider ? git.url : gitHookUrl(serverUrl, board.id, provider);
  const secretNow = secret.trim() || shown;
  const form = (
    <Card title={t('git.card')} footer={t('git.footer', { key: board.key })}>
      <Row label={t('git.provider')}>
        <Select className="w-56" value={String(provider)} onChange={(e) => setProvider(asEnum(GitProvider, Number(e.target.value)))} aria-label={t('git.provider')} data-testid="git-provider">
          {GIT_PROVIDERS.map((p) => (
            <option key={p.v} value={p.v}>
              {t(p.label)}
            </option>
          ))}
        </Select>
      </Row>
      <Row label={t('git.secret')} hint={git?.hasSecret ? t('git.secretKept') : t('git.secretHint')}>
        <div className="flex items-center gap-1.5">
          <Input className="w-56" value={secret} maxLength={256} placeholder={t('git.secretPh')} onChange={(e) => setSecret(e.target.value)} aria-label={t('git.secret')} data-testid="git-secret" />
          <Tip label={t('git.secretGenTip')}>
            <Button size="sm" variant="secondary" onClick={() => setSecret(generateGitSecret())} data-testid="git-secret-gen">
              <Dices className="size-3.5" aria-hidden /> {t('git.secretAuto')}
            </Button>
          </Tip>
          {secret.trim() ? (
            <Button size="sm" variant="secondary" onClick={() => copyText(secret.trim(), t('git.secretCopied'))} aria-label={t('git.copy')} data-testid="git-secret-copy">
              <Copy className="size-3.5" aria-hidden />
            </Button>
          ) : null}
        </div>
      </Row>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <Button size="sm" busy={busy} disabled={!secretOk} onClick={() => void save()} data-testid="git-save">
          {git ? t('common.save') : t('git.connect')}
        </Button>
        {git ? (
          <>
            <span className="flex-1" />
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => void remove()} data-testid="git-delete">
              <Trash2 className="size-3.5" aria-hidden /> {t('git.delete')}
            </Button>
          </>
        ) : null}
      </div>
    </Card>
  );
  return (
    <>
      {shown ? (
        <Card title={t('git.secretOnce')} footer={t('git.secretOnceHint')}>
          <div className="flex items-center gap-2 px-3 py-2" data-testid="git-secret-shown">
            <code className="selectable min-w-0 flex-1 truncate font-mono text-caption">{shown}</code>
            <Button size="sm" variant="secondary" onClick={() => copyText(shown, t('git.secretCopied'))}>
              <Copy className="size-3.5" aria-hidden /> {t('git.copy')}
            </Button>
          </div>
        </Card>
      ) : null}
      {allowed ? form : <PlanLock plan="team" testId="git-lock">{form}</PlanLock>}
      {allowed && git?.provider === GitProvider.GITLAB ? <BacklinkCard board={board} git={git} onSaved={setGit} /> : null}
      <Card title={t('git.url')} footer={git ? undefined : t('git.urlPre')}>
        <div className="flex items-center gap-2 px-3 py-2" data-testid="git-url">
          {url ? (
            <>
              <code className="selectable min-w-0 flex-1 truncate font-mono text-caption">{url}</code>
              <Button size="sm" variant="secondary" onClick={() => copyText(url, t('git.urlCopied'))} data-testid="git-url-copy">
                <Copy className="size-3.5" aria-hidden /> {t('git.copy')}
              </Button>
            </>
          ) : (
            <span className="text-body text-muted">{t('git.urlLater')}</span>
          )}
        </div>
      </Card>
      <Card title={t('git.howTo')} footer={t('git.stepsFoot')}>
        <ol className="flex flex-col gap-2 px-3 py-2.5 text-body" data-testid="git-how">
          {[...(GIT_STEPS[provider] ?? []), ...GIT_STEPS_COMMON].map((st, n) => (
            <GuideStep key={st.text} n={n + 1} step={st} boardKey={board.key} url={url} secret={secretNow} />
          ))}
        </ol>
      </Card>
      {git ? <GitStatus git={git} workspaceId={board.workspaceId} /> : null}
    </>
  );
}

/**
 * «Ссылка на задачу в GitLab» (board task #101): off by default — the note carries the task's
 * title to everyone who can read the merge request. The token is write-only: the field stays
 * empty, «Задан» says one is kept, an empty save keeps it, «Удалить токен» removes it.
 */
function BacklinkCard({ board, git, onSaved }: { board: Board; git: BoardGit; onSaved: (g: BoardGit) => void }): ReactNode {
  const [url, setUrl] = useState(git.gitlabUrl);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (patch: { backlink?: boolean; apiToken?: string; gitlabUrl?: string }): Promise<void> => {
    setBusy(true);
    const g = await saveBacklink(board.workspaceId, board.id, patch);
    setBusy(false);
    if (!g) return;
    onSaved(g);
    setToken('');
    setUrl(g.gitlabUrl);
  };
  const dirty = token.trim() !== '' || url.trim() !== git.gitlabUrl;
  const status = !git.backlinkError ? '' : !git.hasApiToken ? t('git.backlink.noToken') : !git.gitlabUrl ? t('git.backlink.noUrl') : t('git.lastError', { error: git.backlinkError });
  return (
    <Card title={t('git.backlink.card')} footer={t('git.backlink.footer')}>
      <div className="px-3 py-1.5" data-testid="git-backlink">
        <Switch checked={git.backlink} disabled={busy} onChange={(v) => void save({ backlink: v })} label={t('git.backlink.switch')} hint={t('git.backlink.hint', { key: board.key })} />
      </div>
      <Row label={t('git.backlink.url')}>
        <Input className="w-64" value={url} maxLength={512} placeholder="https://gitlab.com" onChange={(e) => setUrl(e.target.value)} aria-label={t('git.backlink.url')} data-testid="git-backlink-url" />
      </Row>
      <Row label={t('git.backlink.token')} hint={git.hasApiToken ? t('git.backlink.tokenKept') : t('git.backlink.tokenHint')}>
        <PasswordInput className="w-64" value={token} maxLength={256} autoComplete="off" placeholder={git.hasApiToken ? '••••••••' : 'glpat-…'} onChange={(e) => setToken(e.target.value)} aria-label={t('git.backlink.token')} data-testid="git-backlink-token" />
      </Row>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <Button size="sm" busy={busy} disabled={!dirty} onClick={() => void save({ ...(token.trim() ? { apiToken: token.trim() } : {}), ...(url.trim() !== git.gitlabUrl ? { gitlabUrl: url.trim() } : {}) })} data-testid="git-backlink-save">
          {t('common.save')}
        </Button>
        {git.hasApiToken ? (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void save({ apiToken: '' })} data-testid="git-backlink-forget">
            {t('git.backlink.forget')}
          </Button>
        ) : null}
      </div>
      {status ? (
        <p className="break-words px-3 pb-2.5 text-caption text-danger-text" role="status" data-testid="git-backlink-error">
          {status}
        </p>
      ) : null}
    </Card>
  );
}

/** One numbered step; an inline «Скопировать» when the step wants the URL / the secret and it is known. */
export function GuideStep({ n, step, boardKey, url, secret }: { n: number; step: GitStep; boardKey: string; url: string; secret: string }): ReactNode {
  const value = step.copy === 'url' ? url : step.copy === 'secret' ? secret : '';
  return (
    <li className="flex items-start gap-2.5">
      <span className="grid size-5 shrink-0 place-items-center rounded-full bg-[var(--color-card-line)] text-caption font-semibold text-muted" aria-hidden>
        {n}
      </span>
      <span className="min-w-0 flex-1 break-words text-muted">{t(step.text, { key: boardKey })}</span>
      {value ? (
        <Button size="sm" variant="secondary" onClick={() => copyText(value, step.copy === 'url' ? t('git.urlCopied') : t('git.secretCopied'))} aria-label={t('git.copy')}>
          <Copy className="size-3.5" aria-hidden />
        </Button>
      ) : null}
    </li>
  );
}

function GitStatus({ git, workspaceId }: { git: BoardGit; workspaceId: string }): ReactNode {
  const lines: Array<{ key: string; text: string; danger?: boolean }> = [];
  lines.push({ key: 'last', text: git.lastEventAt ? t('git.lastEvent', { date: fmt.full(timestampDate(git.lastEventAt)) }) : t('git.noEvents') });
  lines.push({ key: 'n', text: t('git.events', { n: git.eventsCount }) });
  if (git.lastError) lines.push({ key: 'err', text: t('git.lastError', { error: git.lastError }), danger: true });
  if (git.createdBy) lines.push({ key: 'by', text: t('git.createdBy', { name: memberName(workspaceId, git.createdBy) }) });
  return (
    <Card title={t('git.status')}>
      <ul className="flex flex-col gap-1 px-3 py-2.5 text-body" data-testid="git-status">
        {lines.map((l) => (
          <li key={l.key} className={cx('break-words', l.danger ? 'text-danger-text' : 'text-muted')}>
            {l.text}
          </li>
        ))}
      </ul>
    </Card>
  );
}
