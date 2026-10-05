import { AudioWaveform, Bell, MailCheck, Mic, MonitorUp, TriangleAlert, Users } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { PermissionStatus, ScreenAccess } from '../../../shared/ipc';
import { Logo } from '../../components/Logo';
import { Button, Field, Input, Segmented, Select, cx } from '../../components/ui';
import { t } from '../../i18n';
import { platform } from '../../platform';
import { voice } from '../../services/voice';
import { usePrefs } from '../../stores/prefs';
import { useSession } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { useWorkspaces } from '../../stores/workspaces';
import { useInvite } from '../../stores/invite';
import { MicMeter } from '../settings/MicMeter';
import { PttBinder, bindingLabel } from '../settings/PttBinder';
import { notifyStepView, readNotifyState, requestNotify, type NotifyState } from '../../lib/notifyPermission';
import { screenStepState, screenStepView } from '../../lib/screenPermission';
import { resendVerification, verifyEmail } from '../../services/email';
import { CodeInput, CodeNote, ResendButton, useCodeAddress, useCodeFlow } from '../auth/VerifyEmail';
import { asksToVerify, verifyReason } from '../auth/verifyAsk';
import { InvitePreviewRow, useInviteJoin } from '../workspace/WorkspaceDialogs';
import { joinPlaceholder } from '../../services/links';
import { micStateAfterRequest, micStateOnArrival, nextStep, onboardingSteps, prevStep, resolveStep, type MicState, type Step } from './steps';

/**
 * First run (docs/08 «Онбординг», docs/09 #20, #55): one card per step — an icon illustration, a
 * title, one sentence of «why», the step's body, and Setup-Assistant actions (Назад on the left,
 * «Позже» + the primary action on the right). Three zones inside a card of one height: the
 * header is anchored at the top (titles at the same height on every step), the footer at the
 * bottom (buttons too), and the body is centred between them — every step has one, so no step
 * shows an empty card. Everything is skippable; each permission is asked at its step.
 */
function useIsMacDesktop(): boolean {
  const os = useSession((s) => s.appInfo?.platform);
  return os === 'darwin' && platform.kind === 'electron';
}

interface Nav {
  next: () => void;
  back: (() => void) | null;
}

export function Onboarding(): ReactNode {
  const mac = useIsMacDesktop();
  // «Подтвердите почту» first (ADR-0023): right after sign-up the code is in the inbox and the
  // user's attention is on it. «Позже» leaves the bar in the main window instead. Fixed at mount
  // from the sign-up / sign-in answer (verifyAsk.ts: not with EMAIL_VERIFICATION=optional unless
  // an email invitation waits, ADR-0065); READY may only drop it (a restored session has no flags).
  const [verifyAtMount] = useState(() => asksToVerify(useSession.getState()));
  const verifyAsked = useSession((s) => !s.ready || !s.emailVerificationOptional || s.emailInvitePending);
  const withVerify = verifyAtMount && verifyAsked;
  // Before READY nothing is known: no join step rather than one that vanishes a moment later.
  const hasWorkspace = useWorkspaces((s) => s.order.length > 0);
  const ready = useSession((s) => s.ready);
  const invited = useInvite((s) => s.signedUp);
  const steps = onboardingSteps({ verify: withVerify, mac, hasWorkspace: hasWorkspace || !ready, invited });
  // The step survives a relaunch (macOS asks to quit and reopen after some grants): prefs.
  const saved = usePrefs((s) => s.onboardingStep);
  const [resumed] = useState(() => usePrefs.getState().onboardingStep);
  const step = resolveStep(steps, saved);
  const i = steps.indexOf(step);
  const go = (s: Step | null): void => {
    if (s) usePrefs.getState().setPrefs({ onboardingStep: s });
  };
  // What the user actually set up, so «Всё готово» does not claim a mic check that was skipped.
  const [micChecked, setMicChecked] = useState(false);
  const back = prevStep(steps, step);
  const nav: Nav = {
    next: () => go(nextStep(steps, step)),
    back: back ? () => go(back) : null,
  };
  const finish = (): void => {
    voice.stopMicTest();
    usePrefs.getState().setPrefs({ onboarded: true, onboardingStep: '' });
  };

  return (
    // The composition (progress dots, card, «Пропустить настройку») is centred in the window. On
    // windows ≥ 700 px tall the card has one height for every step (the tallest, PTT with the
    // Input Monitoring note), so the dots, the title and the Back/Continue buttons keep their
    // coordinates from step to step; shorter windows get the natural height (scrolls if needed).
    // m-auto (not place-items) keeps the top reachable when the content overflows.
    <div className="mat-content drag flex h-full flex-col overflow-y-auto px-4 py-4 mobile:pb-[calc(var(--safe-bottom)+16px)] mobile:pt-[calc(var(--safe-top)+16px)]">
      <div className="no-drag m-auto flex w-full max-w-[520px] flex-col gap-5" data-testid={`onboarding-${step}`}>
        <ol className="flex h-2 items-center justify-center gap-2" aria-label={t('onb.progress', { n: i + 1, total: steps.length })}>
          {steps.map((s, n) => (
            <li
              key={s}
              aria-current={n === i ? 'step' : undefined}
              className={cx('h-2 rounded-full transition-[width,background-color] duration-[var(--motion)]', n === i ? 'w-5 bg-accent' : n < i ? 'w-2 bg-accent' : 'w-2 bg-[var(--color-fill-hover)]')}
            />
          ))}
        </ol>
        <div className="flex flex-col [@media(min-height:600px)]:min-h-[488px]" data-onb-card>
          {step === 'verify' ? <VerifyStep nav={nav} /> : null}
          {step === 'mic' ? <MicStep nav={nav} onResult={setMicChecked} resumed={resumed === 'mic'} /> : null}
          {step === 'screen' ? <ScreenStep nav={nav} /> : null}
          {step === 'notifications' ? <NotificationsStep nav={nav} /> : null}
          {step === 'mode' ? <ModeStep nav={nav} /> : null}
          {step === 'join' ? <JoinStep nav={nav} /> : null}
          {step === 'done' ? <DoneStep nav={nav} onFinish={finish} micChecked={micChecked} /> : null}
        </div>
        {/* Kept (invisible) on the last step too, so the composition does not shift. */}
        <button
          type="button"
          onClick={finish}
          aria-hidden={step === 'done' || undefined}
          tabIndex={step === 'done' ? -1 : undefined}
          className={cx('self-center rounded-[var(--radius-control)] px-2 py-1 text-caption mobile:min-h-10 mobile:px-3 text-muted hover:text-fg hover:underline', step === 'done' && 'invisible')}
        >
          {t('onb.skipAll')}
        </button>
      </div>
    </div>
  );
}

function StepFrame({
  illustration,
  title,
  text,
  children,
  actions,
  back,
}: {
  illustration: ReactNode;
  title: string;
  text: string;
  children?: ReactNode;
  actions: ReactNode;
  back: (() => void) | null;
}): ReactNode {
  return (
    <section className="mat-popover flex min-h-[300px] flex-1 flex-col rounded-[var(--radius-panel)] p-6">
      <div className="flex shrink-0 flex-col items-center gap-3 text-center" data-onb-head>
        {illustration}
        <h1 className="text-large font-semibold">{title}</h1>
        <p className="max-w-[420px] text-body text-muted">{text}</p>
      </div>
      {/* Symmetric padding: the body's centre is the centre of the space between header and footer. */}
      <div className="flex min-h-10 flex-1 flex-col justify-center py-5" data-onb-area>
        {children ? (
          <div className="flex flex-col gap-3" data-onb-body>
            {children}
          </div>
        ) : null}
      </div>
      {/* Wraps on phones only: on desktop the longest step («Запросить доступ и открыть настройки»)
          fits the 520 px card in one row and must keep the Back/Continue coordinates. */}
      <div className="flex shrink-0 items-center gap-2 mobile:flex-wrap" data-onb-footer>
        {back ? (
          <Button variant="ghost" size="lg" onClick={back}>
            {t('onb.back')}
          </Button>
        ) : null}
        <div className="ml-auto flex justify-end gap-2 mobile:flex-wrap">{actions}</div>
      </div>
    </section>
  );
}

/** Step illustration: a large glyph on a soft accent disc (no gradients, docs/08). */
function Illustration({ icon: Icon }: { icon: typeof Mic }): ReactNode {
  return (
    <span className="grid size-16 place-items-center rounded-full bg-[color-mix(in_srgb,var(--color-accent)_16%,transparent)] text-accent" aria-hidden>
      <Icon className="size-8" strokeWidth={1.75} />
    </span>
  );
}

/** Yellow-tint note with ⚠︎ for something still to do (not an error). */
function WarnNote({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="flex items-start gap-2 rounded-[var(--radius-card)] bg-mention px-3 py-2.5 text-left text-body text-fg" role="status">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
      <div className="flex min-w-0 flex-col gap-2">{children}</div>
    </div>
  );
}

function MicStep({ nav, onResult, resumed }: { nav: Nav; onResult: (checked: boolean) => void; resumed: boolean }): ReactNode {
  const [state, setState] = useState<MicState>('idle');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const micId = usePrefs((s) => s.micDeviceId);
  const setPrefs = usePrefs((s) => s.setPrefs);
  const micError = useVoice((s) => s.micError);
  const os = useSession((s) => s.appInfo?.platform);

  // A grant applies to this process at once: straight on to the level check, no relaunch.
  const ask = async (): Promise<void> => {
    setState('asking');
    const granted = await platform.system.requestMic();
    if (granted) {
      await voice.startMicTest();
      setDevices((await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default'));
    }
    setState(micStateAfterRequest(granted, useVoice.getState().micError));
  };
  // Back on this step after a relaunch with the access already given: the check starts by itself.
  const auto = useRef(false);
  useEffect(() => {
    if (!resumed || auto.current) return;
    auto.current = true;
    void platform.system.permissions().then((p) => {
      if (micStateOnArrival(p.microphone) === 'granted') void ask();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once on arrival
  }, []);

  const ok = state === 'ok';
  return (
    <StepFrame
      illustration={<Illustration icon={Mic} />}
      title={ok ? t('onb.micCheckTitle') : t('onb.micTitle')}
      text={ok ? t('onb.micCheckText') : t('onb.micText')}
      back={nav.back}
      actions={
        <>
          <Button
            variant="secondary"
            size="lg"
            onClick={() => {
              onResult(false);
              nav.next();
            }}
          >
            {t('onb.later')}
          </Button>
          {ok ? (
            <Button
              size="lg"
              onClick={() => {
                onResult(true);
                nav.next();
              }}
            >
              {t('onb.micGood')}
            </Button>
          ) : (
            <Button size="lg" busy={state === 'asking'} onClick={() => void ask()}>
              {t('onb.micAllow')}
            </Button>
          )}
        </>
      }
    >
      {state === 'idle' || state === 'asking' ? <MicPreview /> : null}
      {ok ? (
        <div className="flex flex-col gap-3">
          <Select aria-label={t('voice.input')} value={micId ?? ''} onChange={(e) => setPrefs({ micDeviceId: e.target.value || null })}>
            <option value="">{t('voice.defaultDevice')}</option>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || d.deviceId.slice(0, 8)}
              </option>
            ))}
          </Select>
          <MicMeter />
        </div>
      ) : null}
      {state === 'denied' ? (
        <WarnNote>
          <p>{micError ?? t('onb.micDenied')}</p>
          {platform.kind === 'electron' && (os === 'darwin' || os === 'win32') ? (
            <Button variant="secondary" size="sm" className="self-start" onClick={() => void platform.system.openPrivacySettings('microphone')}>
              {t('perm.openOs')}
            </Button>
          ) : (
            <p className="text-muted">{t('onb.micDeniedWeb')}</p>
          )}
        </WarnNote>
      ) : null}
    </StepFrame>
  );
}

function VerifyStep({ nav }: { nav: Nav }): ReactNode {
  const email = useCodeAddress();
  const noteId = useId();
  // The confirmation may join workspaces (emailed invitations): verifyEmail opens the first and
  // says so in its one toast; the join step then drops out of the run by itself.
  const flow = useCodeFlow(verifyEmail, resendVerification, nav.next);
  const join = useSession((s) => verifyReason(s) === 'join');
  return (
    <StepFrame
      illustration={<Illustration icon={MailCheck} />}
      title={t('mail.step.title')}
      text={t('mail.step.text', { email })}
      back={nav.back}
      actions={
        <>
          <Button variant="secondary" size="lg" onClick={nav.next}>
            {t('onb.later')}
          </Button>
          <Button size="lg" busy={flow.state.busy === 'verify'} onClick={flow.submit}>
            {t('mail.confirm')}
          </Button>
        </>
      }
    >
      <div className="mx-auto flex w-full max-w-[260px] flex-col items-center gap-2">
        <CodeInput flow={flow} autoFocus label={t('mail.code')} describedBy={noteId} className="h-10 text-large" />
        <CodeNote flow={flow} id={noteId} className="text-center" />
        <ResendButton flow={flow} />
      </div>
      <p className="text-center text-caption text-muted">{t(join ? 'mail.step.laterJoin' : 'mail.step.later')}</p>
    </StepFrame>
  );
}

function ModeStep({ nav }: { nav: Nav }): ReactNode {
  const p = usePrefs();
  return (
    <StepFrame
      illustration={<Illustration icon={AudioWaveform} />}
      title={t('onb.modeTitle')}
      text={t('onb.modeText')}
      back={nav.back}
      actions={
        <Button size="lg" onClick={nav.next}>
          {t('onb.next')}
        </Button>
      }
    >
      <div className="flex flex-col items-center gap-4">
        <Segmented
          label={t('voice.mode')}
          value={p.micMode}
          onChange={(m) => p.setPrefs({ micMode: m })}
          options={[
            { value: 'voice', label: t('voice.modeVad') },
            { value: 'ptt', label: t('voice.modePtt') },
          ]}
        />
        {p.micMode === 'ptt' ? (
          <div className="w-full rounded-[var(--radius-card)] bg-[var(--color-card)] p-3">
            <PttBinder compact />
          </div>
        ) : (
          <p className="text-center text-body text-muted">{t('onb.vadText')}</p>
        )}
      </div>
    </StepFrame>
  );
}

function ScreenStep({ nav }: { nav: Nav }): ReactNode {
  // docs/09 P0 #3: macOS lists Calab under Screen Recording only after a capture attempt, and a
  // new grant usually applies after a relaunch — see lib/screenPermission.
  const [access, setAccess] = useState<ScreenAccess | null>(null);
  const [requested, setRequested] = useState(false);
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    const check = (): void => void platform.system.screenAccess().then(setAccess);
    check();
    // Back from System Settings: re-read the status.
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, []);
  const view = screenStepView(screenStepState(access, requested));
  const request = (): void => {
    setAsking(true);
    void platform.system
      .requestScreenAccess()
      .then(setAccess)
      .finally(() => {
        setRequested(true);
        setAsking(false);
      });
  };
  const relaunch = (): void => void platform.system.relaunch();
  return (
    <StepFrame
      illustration={<Illustration icon={MonitorUp} />}
      title={t('onb.screenTitle')}
      text={t('onb.screenText')}
      back={nav.back}
      actions={
        <>
          {view.later ? (
            <Button variant="secondary" size="lg" onClick={nav.next}>
              {t('onb.later')}
            </Button>
          ) : null}
          {view.primary === 'request' ? (
            <Button size="lg" busy={asking} onClick={request}>
              {t('onb.screenRequest')}
            </Button>
          ) : view.primary === 'reopen' ? (
            <Button size="lg" busy={asking} onClick={request}>
              {t('perm.openOs')}
            </Button>
          ) : view.primary === 'restart' ? (
            <Button size="lg" onClick={relaunch}>
              {t('onb.relaunch')}
            </Button>
          ) : (
            <Button size="lg" onClick={nav.next}>
              {t('onb.next')}
            </Button>
          )}
        </>
      }
    >
      {view.note === 'granted' ? (
        <p className="rounded-[var(--radius-card)] bg-[var(--color-card)] p-3 text-center text-body text-ok" role="status">
          {t('onb.screenOk')}
        </p>
      ) : (
        <WarnNote>
          <p>
            {view.note === 'waiting'
              ? t('onb.screenWaiting')
              : view.note === 'restart'
                ? t('onb.screenNeedsRestart')
                : view.note === 'restricted'
                  ? t('onb.screenRestricted')
                  : t('onb.screenRestart')}
          </p>
          {view.restartInNote ? (
            <Button variant="secondary" size="sm" className="self-start" onClick={relaunch}>
              {t('onb.relaunch')}
            </Button>
          ) : null}
        </WarnNote>
      )}
    </StepFrame>
  );
}

function NotificationsStep({ nav }: { nav: Nav }): ReactNode {
  // `default` = not asked yet: offer «Включить уведомления» — never the «denied» note (docs/09 #20).
  // Desktop: Electron always reports «granted» and knows nothing of the OS setting, so the step
  // starts as «not asked»; enabling turns mentions on and shows a first notification — on macOS
  // that is when the system asks for permission.
  const desktop = platform.kind === 'electron';
  const [state, setState] = useState<NotifyState>(() => (desktop ? 'default' : readNotifyState()));
  const [asking, setAsking] = useState(false);
  const view = notifyStepView(state);
  const enable = (): void => {
    if (desktop) {
      usePrefs.getState().setPrefs({ notifyMentions: true });
      try {
        new Notification('Calab', { body: t('onb.notifOn') });
      } catch {
        // No notification support: the in-app badges still work.
      }
      setState('granted');
      return;
    }
    // Straight from the click (user gesture): requestNotify calls Notification.requestPermission now.
    setAsking(true);
    void requestNotify().then((next) => {
      setAsking(false);
      setState(next);
      if (next === 'granted') usePrefs.getState().setPrefs({ notifyMentions: true });
    });
  };
  return (
    <StepFrame
      illustration={<Illustration icon={Bell} />}
      title={t('onb.notifTitle')}
      text={t('onb.notifText')}
      back={nav.back}
      actions={
        <>
          {view.later ? (
            <Button variant="secondary" size="lg" onClick={nav.next}>
              {t('onb.later')}
            </Button>
          ) : null}
          {view.primary === 'enable' ? (
            <Button size="lg" busy={asking} onClick={enable}>
              {t('onb.notifAllow')}
            </Button>
          ) : (
            <Button size="lg" onClick={nav.next}>
              {view.primary === 'continue-without' ? t('onb.notifWithout') : t('onb.next')}
            </Button>
          )}
        </>
      }
    >
      <NotificationSample />
      {view.note === 'granted' ? (
        <p className="rounded-[var(--radius-card)] bg-[var(--color-card)] p-3 text-center text-body text-ok" role="status">
          {t('onb.notifOn')}
        </p>
      ) : view.note === 'denied' ? (
        <WarnNote>{platform.kind === 'web' ? t('onb.notifDeniedWeb') : t('onb.notifDenied')}</WarnNote>
      ) : view.note === 'unsupported' ? (
        <p className="text-center text-body text-muted" role="status">
          {t('onb.notifUnsupported')}
        </p>
      ) : null}
    </StepFrame>
  );
}

/**
 * «Присоединиться к пространству» (docs/09 #36): last before «Готово», only without any workspace
 * and not after a sign-up by an invitation. A successful join adds the workspace, so the step
 * leaves the run and the next one («Готово») shows.
 */
function JoinStep({ nav }: { nav: Nav }): ReactNode {
  const [input, setInput] = useState('');
  const serverUrl = useSession((s) => s.serverUrl);
  const open = useUi((s) => s.openDialog);
  const { code, preview, join, canJoin, error } = useInviteJoin(input, () => undefined);
  const submit = (): void => {
    if (canJoin) join.mutate({ code: code ?? '' });
  };
  return (
    <StepFrame
      illustration={<Illustration icon={Users} />}
      title={t('mail.inv.joinTitle')}
      text={t('mail.inv.joinText')}
      back={nav.back}
      actions={
        <>
          <Button variant="secondary" size="lg" onClick={nav.next}>
            {t('onb.later')}
          </Button>
          <Button size="lg" busy={join.isPending} disabled={!canJoin} onClick={submit}>
            {t('ws.join')}
          </Button>
        </>
      }
    >
      <div className="mx-auto flex w-full max-w-[380px] flex-col gap-3">
        <Field label={t('ws.inviteCode')} error={error}>
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            placeholder={joinPlaceholder(serverUrl)}
            spellCheck={false}
            className="h-9"
          />
        </Field>
        <InvitePreviewRow preview={preview} />
        {/* No invitation: a workspace of one's own (the step's footer keeps two actions). */}
        <p className="text-center text-body text-muted">
          {t('mail.inv.noInvite')}{' '}
          <button
            type="button"
            className="rounded-[var(--radius-control)] text-accent-text hover:underline"
            onClick={() => {
              usePrefs.getState().setPrefs({ onboarded: true, onboardingStep: '' });
              open({ kind: 'create-workspace' });
            }}
          >
            {t('ws.create')}
          </button>
        </p>
      </div>
    </StepFrame>
  );
}

function DoneStep({ nav, onFinish, micChecked }: { nav: Nav; onFinish: () => void; micChecked: boolean }): ReactNode {
  const hasWs = useWorkspaces((s) => s.order.length > 0);
  const open = useUi((s) => s.openDialog);
  const summary = useSetupSummary(micChecked);
  return (
    <StepFrame
      illustration={<Logo size={64} />}
      title={t('onb.doneTitle')}
      text={hasWs ? (micChecked ? t('onb.doneText') : t('onb.doneTextNoMic')) : micChecked ? t('onb.doneNoWs') : t('onb.doneNoWsNoMic')}
      back={nav.back}
      actions={
        hasWs ? (
          <Button size="lg" onClick={onFinish}>
            {t('onb.start')}
          </Button>
        ) : (
          <>
            <Button
              variant="secondary"
              size="lg"
              onClick={() => {
                onFinish();
                open({ kind: 'join-workspace' });
              }}
            >
              {t('ws.join')}
            </Button>
            <Button
              size="lg"
              onClick={() => {
                onFinish();
                open({ kind: 'create-workspace' });
              }}
            >
              {t('ws.create')}
            </Button>
          </>
        )
      }
    >
      <dl className="mx-auto w-full max-w-[380px] divide-y divide-[var(--color-card-line)] overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)] text-body" data-testid="onboarding-summary">
        {summary.map((r) => (
          <div key={r.label} className="flex items-center justify-between gap-4 px-3 py-2">
            <dt className="shrink-0 text-muted">{r.label}</dt>
            <dd className={cx('min-w-0 truncate text-right', r.pending ? 'text-muted' : 'text-fg')} title={r.value}>
              {r.value}
            </dd>
          </div>
        ))}
      </dl>
    </StepFrame>
  );
}

interface SummaryRow {
  label: string;
  value: string;
  /** Skipped / not set: muted. */
  pending: boolean;
}

/** «Всё готово»: what the user actually set up (docs/09 #55) — device, mode, screen, notifications. */
function useSetupSummary(micChecked: boolean): SummaryRow[] {
  const micId = usePrefs((s) => s.micDeviceId);
  const mode = usePrefs((s) => s.micMode);
  const binding = usePrefs((s) => s.pttBinding);
  const notifyMentions = usePrefs((s) => s.notifyMentions);
  const os = useSession((s) => s.appInfo?.platform) ?? '';
  const mac = useIsMacDesktop();
  const [micLabel, setMicLabel] = useState<string | null>(null);
  const [screen, setScreen] = useState<PermissionStatus['screen'] | null>(null);
  useEffect(() => {
    if (!micChecked || !micId) return;
    void navigator.mediaDevices
      .enumerateDevices()
      .then((ds) => setMicLabel(ds.find((d) => d.kind === 'audioinput' && d.deviceId === micId)?.label || null))
      .catch(() => undefined);
  }, [micChecked, micId]);
  useEffect(() => {
    if (mac) void platform.system.permissions().then((p) => setScreen(p.screen));
  }, [mac]);
  const notifOn = notifyMentions && (platform.kind === 'electron' || readNotifyState() === 'granted');
  const rows: SummaryRow[] = [
    {
      label: t('onb.sumMic'),
      value: micChecked ? (micLabel ?? t('voice.defaultDevice')) : t('onb.sumMicSkipped'),
      pending: !micChecked,
    },
    {
      label: t('onb.sumMode'),
      value: mode === 'ptt' ? `${t('voice.modePtt')} · ${binding ? bindingLabel(binding, os) : t('onb.sumNoKey')}` : t('voice.modeVad'),
      pending: mode === 'ptt' && !binding,
    },
  ];
  if (mac) rows.push({ label: t('onb.sumScreen'), value: screen === 'granted' ? t('onb.sumAllowed') : t('onb.sumLater'), pending: screen !== 'granted' });
  rows.push({ label: t('onb.sumNotif'), value: notifOn ? t('onb.sumOn') : t('onb.sumLater'), pending: !notifOn });
  return rows;
}

/** Before the mic is allowed: the device picker and the level track the next state will fill. */
function MicPreview(): ReactNode {
  return (
    <>
      <div className="flex flex-col gap-3" aria-hidden>
        <Select disabled value="" onChange={() => undefined} tabIndex={-1}>
          <option value="">{t('voice.defaultDevice')}</option>
        </Select>
        <div className="relative h-3 w-full">
          <div className="absolute inset-x-0 top-[3px] h-1.5 rounded-[3px] bg-[var(--color-fill-hover)]" />
        </div>
      </div>
      <p className="text-center text-caption text-muted">{t('onb.micPreview')}</p>
    </>
  );
}

/** What a mention notification will look like (illustration, not a real notification). */
function NotificationSample(): ReactNode {
  return (
    <>
      <div
        className="mx-auto flex w-full max-w-[360px] items-start gap-3 rounded-[var(--radius-card)] bg-[var(--color-card)] p-3 text-left shadow-[var(--shadow-card)]"
        aria-hidden
      >
        <Logo size={32} />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between gap-2 text-caption">
            <span className="font-semibold text-fg">Calab</span>
            <span className="text-muted">{t('onb.notifSampleWhen')}</span>
          </div>
          <span className="truncate text-body font-medium text-fg">{t('onb.notifSampleFrom')}</span>
          <span className="truncate text-body text-muted">{t('onb.notifSampleText')}</span>
        </div>
      </div>
      <p className="text-center text-caption text-muted">{t('onb.notifSample')}</p>
    </>
  );
}
