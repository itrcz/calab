import { MailCheck } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Button, Input, cx } from '../../components/ui';
import { t } from '../../i18n';
import { autoFocusAllowed } from '../../lib/phone';
import { resendVerification, verifyEmail } from '../../services/email';
import { useSession } from '../../stores/session';
import { useVerify } from '../../stores/verify';
import { CODE_LENGTH, CodeFlow, formatCountdown, type CodeFlowState } from './emailCode';
import { asksToVerify, verifyReason } from './verifyAsk';

export interface CodeFlowApi {
  state: CodeFlowState;
  /** Seconds left on the resend timer (re-rendered every second while > 0). */
  resendIn: number;
  setCode: (v: string) => void;
  submit: () => void;
  resend: () => void;
  markSent: () => void;
}

/** React wrapper of CodeFlow (emailCode.ts): a completed code submits by itself. */
export function useCodeFlow(
  verify: (code: string) => Promise<void>,
  resend: () => Promise<void>,
  onDone?: () => void,
  { autoSubmit = true }: { autoSubmit?: boolean } = {},
): CodeFlowApi {
  const [state, setState] = useState<CodeFlowState | null>(null);
  const [flow] = useState(() => new CodeFlow({ verify, resend, now: () => Date.now(), onChange: setState }));
  const done = useRef(onDone);
  // The latest callbacks (they close over the caller's state, e.g. the new password).
  useEffect(() => {
    flow.setActions(verify, resend);
    done.current = onDone;
  });
  const [, tick] = useState(0);
  const resendIn = flow.resendLeft();
  useEffect(() => {
    if (resendIn <= 0) return;
    const id = window.setTimeout(() => tick((n) => n + 1), 1000);
    return () => window.clearTimeout(id);
  });
  const submit = (): void =>
    void flow.submit().then((ok) => {
      if (ok) done.current?.();
    });
  return {
    state: state ?? flow.state,
    resendIn,
    setCode: (v) => {
      if (flow.setCode(v) && autoSubmit) submit();
    },
    submit,
    resend: () => void flow.resend(),
    markSent: () => flow.markSent(),
  };
}

/** The 6-digit field: numeric keypad, one-time-code autofill, wide monospace digits. */
export function CodeInput({
  flow,
  inputRef,
  autoFocus,
  className,
  label,
  describedBy,
}: {
  flow: CodeFlowApi;
  inputRef?: RefObject<HTMLInputElement | null>;
  autoFocus?: boolean;
  className?: string;
  label: string;
  describedBy?: string;
}): ReactNode {
  return (
    <Input
      ref={inputRef}
      autoFocus={autoFocus}
      aria-label={label}
      aria-invalid={flow.state.error ? true : undefined}
      aria-describedby={describedBy}
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]*"
      maxLength={CODE_LENGTH + 2}
      placeholder="000000"
      spellCheck={false}
      value={flow.state.code}
      onChange={(e) => flow.setCode(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          flow.submit();
        }
      }}
      className={cx('text-center font-mono tracking-[0.3em] tabular-nums', className)}
    />
  );
}

/** «Отправить снова» / «Отправить снова через 0:42» / «Код отправлен». */
export function ResendButton({ flow, className }: { flow: CodeFlowApi; className?: string }): ReactNode {
  const wait = flow.resendIn > 0;
  return (
    <button
      type="button"
      disabled={wait || flow.state.busy !== null}
      aria-busy={flow.state.busy === 'resend' || undefined}
      onClick={flow.resend}
      className={cx(
        'shrink-0 whitespace-nowrap rounded-[var(--radius-control)] px-1 text-caption text-accent-text tabular-nums hover:underline disabled:cursor-default disabled:text-muted disabled:no-underline mobile:tap-min-h',
        className,
      )}
    >
      {wait ? t('mail.resendIn', { time: formatCountdown(flow.resendIn) }) : t('mail.resend')}
    </button>
  );
}

/** The inline error (or the quiet «Новый код отправлен») under / next to the field. */
export function CodeNote({ flow, id, className }: { flow: CodeFlowApi; id: string; className?: string }): ReactNode {
  if (flow.state.error)
    return (
      <span id={id} role="alert" className={cx('text-caption text-danger-text', className)}>
        {flow.state.error.text}
      </span>
    );
  if (flow.state.resent)
    return (
      <span id={id} role="status" className={cx('text-caption text-muted', className)}>
        {t('mail.resent')}
      </span>
    );
  return null;
}

/** Where the code went: the pending new address, else the account's. */
export function useCodeAddress(): string {
  return useSession((s) => s.me?.pendingEmail || s.me?.email || '');
}

/**
 * «Подтвердите почту» (ADR-0023, docs/08 «Почта»): a thin bar over the main content while
 * `me.emailVerified` is false and the server asks for it (verifyAsk.ts: always with
 * EMAIL_VERIFICATION=required; with optional only while an email invitation waits for the address,
 * ADR-0065). Not dismissable — the code is the only way out. A blocked action
 * (403 EMAIL_NOT_VERIFIED) calls it (stores/verify): the field takes the focus (on a phone only the
 * highlight — the keyboard waits for a tap, lib/phone.ts) and the text says why.
 */
export function VerifyBanner(): ReactNode {
  const show = useSession(asksToVerify);
  if (!show) return null;
  return <VerifyBar />;
}

function VerifyBar(): ReactNode {
  const email = useCodeAddress();
  const join = useSession((s) => verifyReason(s) === 'join');
  const attention = useVerify((s) => s.attention);
  const [seen] = useState(attention);
  const input = useRef<HTMLInputElement>(null);
  const noteId = useId();
  const flow = useCodeFlow(verifyEmail, resendVerification); // verifyEmail toasts
  const asked = attention !== seen;
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!asked) return;
    if (autoFocusAllowed()) input.current?.focus();
    else input.current?.scrollIntoView({ block: 'nearest' });
    const on = window.setTimeout(() => setFlash(true), 0);
    const off = window.setTimeout(() => setFlash(false), 1200);
    return () => {
      window.clearTimeout(on);
      window.clearTimeout(off);
    };
  }, [attention, asked]);
  return (
    <section
      aria-label={t('mail.bar.label')}
      data-testid="verify-banner"
      className={cx(
        'z-[var(--z-sticky)] flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-mention px-3 py-1.5 transition-shadow duration-[var(--motion)] mobile:px-3 mobile:py-2',
        flash && 'shadow-[inset_0_0_0_2px_var(--color-accent)]',
      )}
    >
      <MailCheck className="size-4 shrink-0 text-warn" aria-hidden />
      <p className="min-w-0 flex-1 text-caption text-fg mobile:basis-[calc(100%-28px)]">
        {join
          ? asked
            ? t('mail.bar.neededJoin')
            : t('mail.bar.textJoin', { email })
          : asked
            ? t('mail.bar.needed')
            : t('mail.bar.text', { email })}
      </p>
      <form
        className="flex items-center gap-2 mobile:w-full"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          flow.submit();
        }}
      >
        <CodeInput flow={flow} inputRef={input} label={t('mail.code')} describedBy={noteId} className="h-6 w-[104px] text-caption mobile:tap-h mobile:flex-1" />
        <Button type="submit" size="sm" busy={flow.state.busy === 'verify'}>
          {t('mail.confirm')}
        </Button>
        <ResendButton flow={flow} />
      </form>
      {flow.state.error || flow.state.resent ? <CodeNote flow={flow} id={noteId} className="basis-full text-right mobile:text-left" /> : null}
    </section>
  );
}
