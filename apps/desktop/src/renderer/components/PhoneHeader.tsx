import { ChevronLeft, Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from '../i18n';
import { phoneBack } from '../services/phoneNav';
import { useSearchPanel } from '../stores/searchPanel';
import { useUi } from '../stores/ui';
import { Bar, BAR_GROUP } from './Bar';
import { IconButton } from './ui';

/**
 * The one «back» of every pushed phone screen (ADR-0073 §1, owner 07.10): an iOS chevron on the bar plate (36 px, 44×44
 * hit area), always at the same place of the header. It pops exactly one screen
 * (services/phoneNav.ts phoneBack: through the history, as Android back and the edge swipe do).
 */
export function PhoneBack(): ReactNode {
  return (
    <IconButton tip={false} label={t('mobile.back')} onClick={phoneBack} bar className="text-accent-text hover:text-accent-text" data-testid="phone-back">
      <ChevronLeft className="size-6" strokeWidth={2.25} aria-hidden />
    </IconButton>
  );
}

/** «‹» for the headers shared with the desktop: nothing on a tab root (no screen to go back from). */
export function NavButton(): ReactNode {
  const depth = useUi((s) => s.phone.stack.length);
  return depth === 0 ? null : <PhoneBack />;
}

/**
 * The magnifier left of the «+» on a tab root (owner, 08.10): opens the search screen (the pushed
 * `search` screen; the store's `show` with an empty query, everywhere). Nothing on a pushed screen.
 */
export function PhoneSearchButton(): ReactNode {
  const root = useUi((s) => s.phone.stack.length === 0);
  if (!root) return null;
  return (
    <IconButton tip={false} label={t('common.search')} onClick={() => useSearchPanel.getState().show('', 'all', 'messages')} bar data-testid="phone-search">
      <Search className="size-5" aria-hidden />
    </IconButton>
  );
}

/** The title of a pushed phone screen: the same style everywhere (ADR-0073 §1). */
export const PHONE_TITLE = 'min-w-0 truncate text-list font-semibold leading-5';

/**
 * The header of a pushed screen: «‹» · the title on all the free width (a second line optional) ·
 * up to two icons and «…» (`children`).
 */
export function PhoneHeader({ title, subtitle, children }: { title: ReactNode; subtitle?: string; children?: ReactNode }): ReactNode {
  return (
    <Bar data-testid="phone-header">
      <PhoneBack />
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <h1 className={PHONE_TITLE}>{title}</h1>
        {subtitle ? <span className="min-w-0 truncate text-caption leading-4 text-muted">{subtitle}</span> : null}
      </div>
      {children ? <div className={BAR_GROUP}>{children}</div> : null}
    </Bar>
  );
}
