import { Check, ChevronsUpDown } from 'lucide-react';
import { memo, useCallback, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { PickerPopover } from '../../../components/picker/Picker';
import type { PickerGroup, PickerItem } from '../../../components/picker/pickerModel';
import { cx } from '../../../components/ui';
import { t, useLocale } from '../../../i18n';
import { countryList } from '../../../lib/billing/payer';

interface CountryItem extends PickerItem {
  name: string;
}

/**
 * The payer's country (ADR-0080 §0.1): a select-looking button that opens the one list picker
 * (docs/08 «Выбор участника»): a search by the name in the UI language, the English name or the
 * ISO code; ↑↓ / Enter / Esc; 249 rows, virtualized. ↓ / ↑ on the closed button open it too.
 */
export const CountrySelect = memo(function CountrySelect({
  value,
  codes,
  onChange,
  label,
  invalid,
}: {
  /** ISO 3166-1 alpha-2, "" = none chosen. */
  value: string;
  /** The codes a payer may choose (PayerSchema.all_countries). */
  codes: readonly string[];
  onChange: (code: string) => void;
  /** The field's label: the button is named «Страна: Германия». */
  label: string;
  invalid?: boolean;
}): ReactNode {
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const countries = useMemo(() => countryList(codes, locale), [codes, locale]);
  const groups = useMemo<PickerGroup<CountryItem>[]>(
    () => [{ id: 'countries', label: '', items: countries.map((c) => ({ id: c.code, name: c.name, search: c.search })) }],
    [countries],
  );
  const name = countries.find((c) => c.code === value)?.name ?? '';
  const onSelect = useCallback(
    (item: CountryItem) => {
      onChange(item.id);
      setOpen(false);
    },
    [onChange],
  );
  const renderItem = useCallback(
    (item: CountryItem, active: boolean) => (
      <>
        <span className="min-w-0 flex-1 truncate">{item.name}</span>
        <span className={cx('shrink-0 font-mono text-caption', active ? null : 'text-muted')}>{item.id}</span>
        <Check className={cx('size-3.5 shrink-0', item.id === value ? null : 'invisible')} aria-hidden />
      </>
    ),
    [value],
  );
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
    }
  };
  return (
    <PickerPopover
      groups={groups}
      renderItem={renderItem}
      onSelect={onSelect}
      placeholder={t('billing.payer.countrySearch')}
      label={t('billing.payer.countryList')}
      emptyText={t('billing.payer.countryEmpty')}
      open={open}
      onOpenChange={setOpen}
      width={320}
      testId="payer-country-list"
    >
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-invalid={invalid || undefined}
        aria-label={name ? `${label}: ${name}` : label}
        data-testid="payer-country"
        onKeyDown={onKeyDown}
        className={cx(
          'flex h-7 w-full min-w-0 items-center gap-2 rounded-[var(--radius-control)] border bg-elev pl-2 pr-2 text-left text-body shadow-[var(--shadow-card)] hover:bg-[color:var(--color-control-hover)] mobile:tap-h mobile:pl-3.5 mobile:pr-3',
          invalid ? 'border-danger' : 'border-line',
        )}
      >
        <span className={cx('min-w-0 flex-1 truncate', name ? 'text-fg' : 'text-faint')}>{name || t('billing.payer.countrySearch')}</span>
        {value ? <span className="shrink-0 font-mono text-caption text-muted">{value}</span> : null}
        <ChevronsUpDown className="size-3 shrink-0 text-muted" aria-hidden />
      </button>
    </PickerPopover>
  );
});
