import { ErrorCode } from '@calaba/protocol';
import { useEffect, useState, type ReactNode } from 'react';
import { Input, Row, cx } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { errorText } from '../../lib/api/errors';
import { toast } from '../../stores/toasts';
import { CommitInput } from './CommitInput';
import { normalizeUsername, phoneProblem, usernameProblem, type UsernameState } from './usernameRules';

/** How long typing must pause before the availability check (the server rate-limits it). */
const CHECK_DELAY_MS = 400;

/**
 * «Ник» (ADR-0077): the global nickname with a live availability check under the field, saved on
 * blur / Enter. Format and reserved names are checked here first (no request for those); the
 * server decides at save (409 USERNAME_TAKEN, 422 USERNAME_INVALID).
 */
export function UsernameRow({ value, onSave }: { value: string; onSave: (username: string) => Promise<void> }): ReactNode {
  const [v, setV] = useState(value);
  const [prev, setPrev] = useState(value);
  const [state, setState] = useState<UsernameState>('idle');
  if (prev !== value) {
    setPrev(value);
    setV(value);
    setState('idle');
  }
  const name = normalizeUsername(v);
  useEffect(() => {
    if (name === value || name === '') return undefined;
    const local = usernameProblem(name);
    if (local) return undefined;
    let alive = true;
    const id = window.setTimeout(() => {
      setState('checking');
      api.me.usernameAvailable(name).then(
        (r) => {
          if (!alive) return;
          setState(r.available ? 'free' : r.reason === ErrorCode.USERNAME_TAKEN ? 'taken' : 'invalid');
        },
        () => alive && setState('idle'), // a hint only: the save still decides
      );
    }, CHECK_DELAY_MS);
    return () => {
      alive = false;
      window.clearTimeout(id);
    };
  }, [name, value]);
  const local = name && name !== value ? usernameProblem(name) : null;
  const shown: UsernameState = local ?? (name === value || name === '' ? 'idle' : state);
  const commit = (): void => {
    if (name === value) return;
    if (local === 'invalid' || local === 'reserved' || shown === 'taken') return;
    void onSave(name).catch((e: unknown) => {
      toast.error(errorText(e, t('err.ctx.save')));
      setV(value);
    });
  };
  const hint: Record<UsernameState, string | null> = {
    idle: null,
    checking: t('profile.username.checking'),
    free: t('profile.username.free'),
    taken: t('profile.username.taken'),
    invalid: t('profile.username.invalid'),
    reserved: t('profile.username.reserved'),
  };
  return (
    <Row label={t('profile.username')} hint={t('profile.username.hint')}>
      <div className="flex flex-col items-end gap-1 mobile:w-full mobile:items-stretch">
        <Input
          aria-label={t('profile.username')}
          data-testid="username-input"
          icon={<span className="text-body leading-none">@</span>}
          value={v}
          maxLength={33}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder={t('profile.username.placeholder')}
          onChange={(e) => setV(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape' && v !== value) {
              e.preventDefault();
              e.stopPropagation();
              setV(value);
            }
          }}
          aria-invalid={shown === 'taken' || shown === 'invalid' || shown === 'reserved' ? true : undefined}
          className="w-60 mobile:w-full"
        />
        {hint[shown] ? (
          <p
            className={cx('max-w-72 text-right text-caption mobile:text-left', shown === 'free' ? 'text-ok' : shown === 'checking' ? 'text-muted' : 'text-danger-text')}
            role={shown === 'checking' ? undefined : 'status'}
            data-testid="username-hint"
          >
            {hint[shown]}
          </p>
        ) : null}
      </div>
    </Row>
  );
}

/** «Телефон» (ADR-0077): informational, not verified; "" clears. */
export function PhoneRow({ value, onSave }: { value: string; onSave: (phone: string) => Promise<void> }): ReactNode {
  return (
    <Row label={t('profile.phone')} hint={t('profile.phone.hint')}>
      <CommitInput
        label={t('profile.phone')}
        value={value}
        maxLength={32}
        placeholder={t('profile.phone.placeholder')}
        onCommit={(v) => (phoneProblem(v) ? toast.error(t('profile.phone.invalid')) : onSave(v))}
      />
    </Row>
  );
}
