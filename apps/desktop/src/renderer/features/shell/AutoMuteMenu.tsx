import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Check, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Select, cx } from '../../components/ui';
import { t } from '../../i18n';
import { AUTO_MUTE_LABEL, AUTO_MUTE_OPTIONS } from '../../lib/autoMute';
import { usePrefs } from '../../stores/prefs';
import { menuBox, menuItem } from './menu';
import { selectAutoMute } from './micMenu';

/**
 * Mic ▾ «Выключать, если я молчу» (lib/autoMute.ts, docs/08 «Кнопки голоса»): a submenu with the
 * same options as Settings → «Голос и устройства», the current one checked and shown beside the
 * label. Voice activation only (the caller hides it in push-to-talk). `touch`: phone row height.
 */
export function AutoMuteSubmenu({ touch = false }: { touch?: boolean }): ReactNode {
  const sec = usePrefs((s) => s.autoMuteSec);
  const row = cx(menuItem, 'group relative pl-7', touch && 'h-11');
  return (
    <Dropdown.Sub>
      <Dropdown.SubTrigger className={cx(row, 'data-[state=open]:not-data-[highlighted]:bg-hover')} data-testid="mic-auto-mute">
        <span className="flex-1 truncate">{t('autoMute.menu')}</span>
        <span className="shrink-0 text-caption text-muted group-data-[highlighted]:text-accent-fg">{t(AUTO_MUTE_LABEL[sec])}</span>
        <ChevronRight className="size-3.5 shrink-0 opacity-70" aria-hidden />
      </Dropdown.SubTrigger>
      <Dropdown.Portal>
        <Dropdown.SubContent className={cx(menuBox, 'w-44')} sideOffset={6} alignOffset={-4} collisionPadding={16} aria-label={t('autoMute.label')}>
          <Dropdown.RadioGroup value={String(sec)} onValueChange={selectAutoMute}>
            {AUTO_MUTE_OPTIONS.map((o) => (
              <Dropdown.RadioItem key={o} value={String(o)} className={row} data-testid={`mic-auto-mute-${o}`}>
                <Dropdown.ItemIndicator className="absolute left-2">
                  <Check className="size-3.5" />
                </Dropdown.ItemIndicator>
                {t(AUTO_MUTE_LABEL[o])}
              </Dropdown.RadioItem>
            ))}
          </Dropdown.RadioGroup>
        </Dropdown.SubContent>
      </Dropdown.Portal>
    </Dropdown.Sub>
  );
}

/** Settings → «Голос и устройства» row control: the same options as a select. */
export function AutoMuteSelect({ id }: { id: string }): ReactNode {
  const sec = usePrefs((s) => s.autoMuteSec);
  return (
    <Select id={id} aria-label={t('autoMute.label')} className="w-60" value={String(sec)} onChange={(e) => selectAutoMute(e.target.value)} data-testid="auto-mute-select">
      {AUTO_MUTE_OPTIONS.map((o) => (
        <option key={o} value={String(o)}>
          {t(AUTO_MUTE_LABEL[o])}
        </option>
      ))}
    </Select>
  );
}
