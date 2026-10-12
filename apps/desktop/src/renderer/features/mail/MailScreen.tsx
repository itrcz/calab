import { TriangleAlert } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { Spinner } from '../../components/ui';
import { t } from '../../i18n';
import { shortcutLetter } from '../../services/hotkeys';
import { useMail } from '../../stores/mail';
import { useMailUi } from '../../stores/mailUi';
import { useUi } from '../../stores/ui';
import { moveOpen, replyOpen, stepSelection, toggleOpenRead, trashSelected } from './actions';
import { AddAccountCard } from './AddAccountCard';
import { ComposeSheet } from './ComposeSheet';
import { MailColumn } from './MailColumn';
import { MailThread } from './MailThread';

/**
 * «Почта» (ADR-0088 §8, Apple Mail): the list column and the thread in the centre of the inset
 * panel; no right panel. Without accounts — the add-account card; the composer is a sheet over the
 * centre. Reads three booleans: an event about one message never re-renders this.
 */
export function MailScreen(): ReactNode {
  const loaded = useMail((s) => s.loaded);
  const hasAccounts = useMail((s) => s.accountIds.length > 0);
  const adding = useMailUi((s) => s.adding);
  const compose = useMailUi((s) => s.compose);
  useMailHotkeys();
  return (
    <div className="flex min-w-0 flex-1 overflow-hidden rounded-tl-[var(--radius-panel)] border-l border-t border-[var(--color-panel-edge)]" data-testid="mail-screen">
      {!loaded ? (
        <div className="mat-content grid flex-1 place-items-center">
          <Spinner className="size-6" />
        </div>
      ) : !hasAccounts ? (
        <div className="mat-content flex min-w-0 flex-1 overflow-y-auto">
          <AddAccountCard first />
        </div>
      ) : (
        <>
          <MailColumn />
          <div className="mat-content relative flex min-w-0 flex-1 flex-col">
            <EngineBanner />
            {adding ? (
              <div className="flex min-h-0 flex-1 overflow-y-auto">
                <AddAccountCard first={false} />
              </div>
            ) : (
              <MailThread />
            )}
          </div>
        </>
      )}
      {compose && hasAccounts ? <ComposeSheet key={compose.seq} req={compose} /> : null}
    </div>
  );
}

/** The engine process is restarting (main's `engine: down`): requests fail until it is back. */
function EngineBanner(): ReactNode {
  const down = useMail((s) => s.engineDown);
  if (!down) return null;
  return (
    <div role="status" className="flex h-8 shrink-0 items-center justify-center gap-2 border-b border-line text-caption text-muted">
      <TriangleAlert className="size-3.5 text-warn" aria-hidden />
      {t('mbox.err.engineDown')}
    </div>
  );
}

const typing = (el: EventTarget | null): boolean =>
  el instanceof HTMLElement && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');

/**
 * Apple Mail's keys (§8) while the section is on screen and nothing is typed into / no dialog is
 * open: ⌘R reply, ⇧⌘R reply all, ⇧⌘F forward, ⌘⌫ / Delete trash, ⇧⌘U read ↔ unread, ⌃⌘A archive,
 * ↑/↓ the list. ⌘N comes from the app menu (services/menu.ts) and opens the composer in this section.
 */
function useMailHotkeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.isComposing || typing(e.target)) return;
      if (useUi.getState().dialog || useMailUi.getState().compose || useMailUi.getState().adding) return;
      const mod = e.metaKey || e.ctrlKey;
      const letter = shortcutLetter(e);
      let act: (() => void) | null = null;
      if (mod && !e.altKey && letter === 'r') act = () => replyOpen(e.shiftKey ? 'replyAll' : 'reply');
      else if (mod && e.shiftKey && !e.altKey && letter === 'f') act = () => replyOpen('forward');
      else if (mod && e.shiftKey && !e.altKey && letter === 'u') act = toggleOpenRead;
      else if ((mod && e.key === 'Backspace') || (!mod && !e.shiftKey && e.key === 'Delete')) act = trashSelected;
      else if (!mod && !e.altKey && !e.shiftKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        // Arrows scroll the message when focus is inside the thread; elsewhere they walk the list.
        if (e.target instanceof HTMLElement && e.target.closest('[data-mail-thread]')) return;
        act = () => stepSelection(e.key === 'ArrowDown' ? 1 : -1);
      } else if (e.metaKey && e.ctrlKey && !e.shiftKey && letter === 'a') act = () => moveOpen({ kind: 'archive' }); // ⌃⌘A (macOS)
      if (!act) return;
      e.preventDefault();
      act();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
