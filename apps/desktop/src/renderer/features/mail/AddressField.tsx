import { X } from 'lucide-react';
import { useId, useMemo, useState, type ReactNode, type Ref } from 'react';
import type { MailAddress } from '../../../shared/mail';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { chipFrom, suggest } from './compose';
import { addressFull, addressLabel } from './format';
import { UserAvatar, useMailUser, useUserName } from './people';
import { parseAddressList } from './mailLink';

/**
 * «Кому» / «Копия» / «Скрытая» (ADR-0088 §8): addresses as chips, typed text becomes a chip on
 * Enter, comma, Tab or leaving the field; Backspace on an empty field removes the last chip;
 * suggestions (↑/↓, Enter) from the addresses seen in the mailbox and the members of the workspaces.
 */
export function AddressField({
  label,
  value,
  onChange,
  pool,
  inputRef,
  testId,
  trailing,
}: {
  label: string;
  value: MailAddress[];
  onChange: (next: MailAddress[]) => void;
  pool: readonly MailAddress[];
  inputRef?: Ref<HTMLInputElement>;
  testId: string;
  trailing?: ReactNode;
}): ReactNode {
  const [text, setText] = useState('');
  const [hi, setHi] = useState(0);
  const [focused, setFocused] = useState(false);
  const listId = useId();
  const options = useMemo(() => suggest(pool, text, value), [pool, text, value]);
  const open = focused && options.length > 0;

  const add = (list: MailAddress[]): void => {
    const have = new Set(value.map((a) => a.address));
    const fresh = list.filter((a) => !have.has(a.address));
    if (fresh.length) onChange([...value, ...fresh]);
  };
  const commit = (): boolean => {
    const a = chipFrom(text);
    if (!a) return false;
    add([a]);
    setText('');
    return true;
  };
  const pick = (a: MailAddress): void => {
    add([a]);
    setText('');
    setHi(0);
  };

  return (
    <div className="relative flex min-h-10 flex-wrap items-center gap-1 border-b border-line py-1.5" data-testid={testId}>
      <span className="w-16 shrink-0 text-body text-muted">{label}</span>
      {value.map((a) => (
        <RecipientChip key={a.address} a={a} onRemove={() => onChange(value.filter((x) => x.address !== a.address))} />
      ))}
      <input
        ref={inputRef}
        value={text}
        aria-label={label}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck={false}
        className="selectable h-6 min-w-[120px] flex-1 bg-transparent text-body text-fg outline-none"
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onChange={(e) => {
          setText(e.target.value);
          setHi(0);
        }}
        onPaste={(e) => {
          const list = parseAddressList(e.clipboardData.getData('text'));
          if (list.length < 2) return;
          e.preventDefault();
          add(list);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            setHi((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
            return;
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) return; // ⌘↩ sends (the sheet)
          if ((e.key === 'Enter' || e.key === 'Tab') && open) {
            const o = options[hi];
            if (o) {
              e.preventDefault();
              pick(o);
            }
            return;
          }
          if ((e.key === 'Enter' || e.key === ',' || e.key === ';') && text.trim()) {
            if (commit() || e.key !== 'Enter') e.preventDefault();
            return;
          }
          if (e.key === 'Backspace' && !text && value.length) {
            e.preventDefault();
            onChange(value.slice(0, -1));
            return;
          }
          if (e.key === 'Escape' && text) {
            e.preventDefault();
            e.stopPropagation();
            setText('');
          }
        }}
      />
      {trailing}
      {open ? (
        <ul id={listId} role="listbox" className="mat-popover absolute left-14 top-full z-[var(--z-popover)] mt-1 w-80 rounded-[var(--radius-card)] p-1">
          {options.map((o, i) => (
            <li
              key={o.address}
              role="option"
              aria-selected={i === hi}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(o);
              }}
              onMouseEnter={() => setHi(i)}
              className={cx('flex h-9 cursor-default flex-col justify-center rounded-[6px] px-2.5', i === hi && 'bg-accent-strong text-accent-fg')}
            >
              <span className="truncate text-body leading-4">{o.name || o.address}</span>
              {o.name ? <span className={cx('truncate text-micro leading-4', i === hi ? 'opacity-80' : 'text-muted')}>{o.address}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** A recipient chip; a person of Calab shows their avatar and Calab name (the address in the tooltip). */
function RecipientChip({ a, onRemove }: { a: MailAddress; onRemove: () => void }): ReactNode {
  const userId = useMailUser(a.address);
  const name = useUserName(userId);
  return (
    <span className={cx('inline-flex h-6 max-w-full items-center gap-1 rounded-full bg-hover pr-1 text-caption text-fg', userId ? 'pl-0.5' : 'pl-2.5')} title={addressFull(a)} data-testid="compose-chip">
      {userId ? <UserAvatar userId={userId} size={20} link={false} /> : null}
      <span className="truncate">{name || addressLabel(a)}</span>
      <button
        type="button"
        aria-label={t('mbox.removeRecipient', { address: a.address })}
        className="grid size-4 place-items-center rounded-full text-muted hover:bg-[var(--color-fill-hover)] hover:text-fg"
        onClick={onRemove}
      >
        <X className="size-3" aria-hidden />
      </button>
    </span>
  );
}
