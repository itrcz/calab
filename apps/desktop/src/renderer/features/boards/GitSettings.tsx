import { timestampDate } from '@bufbuild/protobuf/wkt';
import { GitProvider, type Board, type BoardGit } from '@calaba/protocol';
import { Copy, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { confirmAction } from '../../components/Confirm';
import { PlanLock } from '../../components/PlanLock';
import { Button, Card, Input, Row, Select, Spinner, cx } from '../../components/ui';
import { t } from '../../i18n';
import { GIT_PROVIDERS } from '../../lib/boards/git';
import { fmt } from '../../lib/format';
import { planHas } from '../../lib/plan';
import { deleteGit, loadGit, saveGit } from '../../services/automations';
import { copyText } from '../../services/boards';
import { memberName, useWorkspaces } from '../../stores/workspaces';

/**
 * Board settings → «Git» (ADR-0060 §4): the provider (GitHub / GitLab / Gitea-Forgejo), the
 * secret (own or generated — shown once, with «Скопировать»), the webhook address to paste into
 * the repository with «Скопировать», the status (last event, count, last error), a short
 * instruction per provider, «Отключить». MANAGE_BOARD + MANAGE_INTEGRATIONS (the tab is hidden
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
  const how = GIT_PROVIDERS.find((p) => p.v === provider)?.how ?? 'git.how.github';
  const form = (
    <Card title={t('git.card')} footer={t('git.footer', { key: board.key })}>
      <Row label={t('git.provider')}>
        <Select className="w-56" value={String(provider)} onChange={(e) => setProvider(Number(e.target.value))} aria-label={t('git.provider')} data-testid="git-provider">
          {GIT_PROVIDERS.map((p) => (
            <option key={p.v} value={p.v}>
              {t(p.label)}
            </option>
          ))}
        </Select>
      </Row>
      <Row label={t('git.secret')} hint={git?.hasSecret ? t('git.secretKept') : t('git.secretHint')}>
        <Input className="w-72" value={secret} maxLength={256} placeholder={t('git.secretAuto')} onChange={(e) => setSecret(e.target.value)} aria-label={t('git.secret')} data-testid="git-secret" />
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
      {git ? (
        <>
          <Card title={t('git.url')}>
            <div className="flex items-center gap-2 px-3 py-2" data-testid="git-url">
              <code className="selectable min-w-0 flex-1 truncate font-mono text-caption">{git.url}</code>
              <Button size="sm" variant="secondary" onClick={() => copyText(git.url, t('git.urlCopied'))} data-testid="git-url-copy">
                <Copy className="size-3.5" aria-hidden /> {t('git.copy')}
              </Button>
            </div>
          </Card>
          <Card title={t('git.howTo')}>
            <p className="px-3 py-2.5 text-body text-muted" data-testid="git-how">
              {t(how)}
            </p>
          </Card>
          <GitStatus git={git} workspaceId={board.workspaceId} />
        </>
      ) : (
        <Card title={t('git.howTo')}>
          <p className="px-3 py-2.5 text-body text-muted" data-testid="git-how">
            {t(how)}
          </p>
        </Card>
      )}
    </>
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
