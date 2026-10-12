import { TriangleAlert } from 'lucide-react';
import { Fragment, memo, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useLocale } from '../../i18n';
import { t } from '../../i18n';
import { scopeFooter, syncNow, useMail } from '../../stores/mail';
import { useUi } from '../../stores/ui';
import { CopyReport } from './CopyReport';
import { footerView, parseFooter } from './statusFooter';

/**
 * The status footer pinned to the bottom of the mail column (owner 12.10, Apple Mail's «Downloading
 * Messages»): a thin rounded bar, one centred 13/500 line and one muted 12 line under it — progress
 * of a first sync, «Проверка почты» of a background one, or a problem with its button. Replaces the
 * 2 px line, the progress row and the notice row under the header. Idle → nothing is rendered (the
 * list takes the room). The shell subscribes to one primitive (`scopeFooter`); progress events
 * re-render only `FooterBody`.
 */
export const MailStatusFooter = memo(function MailStatusFooter(): ReactNode {
  const key = useMail((s) => scopeFooter(s, s.box.scope));
  const f = parseFooter(key);
  if (!f) return null;
  return (
    <div
      role="status"
      className="mat-sidebar mat-sidebar-window shrink-0 px-4 pt-2 text-center"
      style={{ paddingBottom: 'calc(var(--island-height, -16px) + 24px)' }}
      data-testid="mail-status"
      data-kind={f.kind}
    >
      <FooterBody kind={f.kind} accountId={f.accountId} more={f.more} />
    </div>
  );
});

const FooterBody = memo(function FooterBody({ kind, accountId, more }: { kind: Parameters<typeof footerView>[0]['kind']; accountId: string; more: number }): ReactNode {
  useLocale();
  const email = useMail((s) => s.accounts[accountId]?.email ?? '');
  const multi = useMail((s) => s.accountIds.length > 1);
  const code = useMail((s) => s.accounts[accountId]?.error?.code ?? null);
  const engineFailed = useMail((s) => s.engineReport !== null);
  const report = useMail((s) => s.engineReport ?? '');
  // Only a first sync reads the progress (≤ 2 events/s): primitives, so a repeat re-renders nothing.
  const p = useMail(
    useShallow((s) => {
      const x = kind === 'first' ? s.syncProgress[accountId] : undefined;
      return { phase: x?.phase ?? null, role: x?.folder?.role ?? null, name: x?.folder?.name ?? '', done: x?.done ?? 0, total: x?.total ?? 0 };
    }),
  );
  const v = footerView({ kind, email, multi, more, engineFailed, code, phase: p.phase, folder: { role: p.role, name: p.name }, done: p.done, total: p.total });
  const ratio = kind === 'first' && p.phase !== null && p.phase !== 'folders' && p.total > 0 ? Math.min(1, p.done / p.total) : null;
  return (
    <>
      {v.problem ? null : (
        <div className="mx-auto mb-2 h-1 w-full max-w-[220px] overflow-hidden rounded-full bg-hover" aria-hidden data-testid="mail-status-bar">
          {ratio === null ? <div className="mail-sync-line h-full rounded-full bg-accent" /> : <div className="mail-sync-bar h-full rounded-full bg-accent" style={{ width: `${String(Math.round(ratio * 1000) / 10)}%` }} />}
        </div>
      )}
      <p className="line-clamp-2 text-[13px] font-medium leading-[18px] text-fg" data-testid="mail-status-title">
        {v.problem ? <TriangleAlert className="mr-1.5 inline size-3.5 -translate-y-px text-warn" aria-hidden /> : null}
        {v.title}
      </p>
      {v.parts.length > 0 ? (
        <p className="line-clamp-2 break-words text-[12px] leading-4 text-muted" data-testid="mail-status-detail">
          {v.parts.map((x, n) => (
            <Fragment key={x}>
              {n > 0 ? ' · ' : null}
              <span className="whitespace-nowrap">{x}</span>
            </Fragment>
          ))}
        </p>
      ) : null}
      {v.action === 'report' ? (
        <div className="mt-1 text-[12px]">
          <CopyReport report={report} />
        </div>
      ) : v.action ? (
        <button
          type="button"
          className="mt-1 text-[12px] font-medium text-accent-text hover:underline"
          onClick={() => (v.action === 'password' ? useUi.getState().openDialog({ kind: 'settings', tab: 'mail' }) : void syncNow(accountId))}
          data-testid="mail-status-action"
        >
          {v.action === 'password' ? t('mbox.enterPassword') : t('mbox.retry')}
        </button>
      ) : null}
    </>
  );
});
