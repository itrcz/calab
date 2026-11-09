import { timestampDate } from '@bufbuild/protobuf/wkt';
import { Copy } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Button, Input, Select, Switch } from '../../components/ui';
import { t } from '../../i18n';
import { fmt } from '../../lib/format';
import { isFolder } from '../../lib/disk';
import { diskApi } from '../../services/disk';
import { useDisk } from '../../stores/disk';
import { toast } from '../../stores/toasts';

const EXPIRY_DAYS = [0, 1, 7, 30] as const;
type Expiry = (typeof EXPIRY_DAYS)[number];

/**
 * The public link of a file (ADR-0094 §3) or a folder (ADR-0165): the switch «Доступ по ссылке» (anyone with it downloads
 * the file without signing in), the address with «Скопировать», the term chosen before switching
 * on (changing it means a new link), the download counter. One body for «Ссылка» (the dialog) and
 * the file card (CBF-20); the caller decides who may see it (the owner or DISK_MANAGE).
 */
export function LinkPanel({ itemId }: { itemId: string }): ReactNode {
  const item = useDisk((s) => s.items[itemId]);
  const on = !!item?.link;
  const [url, setUrl] = useState('');
  const [expiry, setExpiry] = useState<Expiry>(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!on || url) return;
    let live = true;
    // The live link is returned as is: the way to read its address.
    diskApi.createLink(itemId).then(
      (r) => live && setUrl(r.url),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [on, url, itemId]);
  if (!item) return null;
  const toggle = (v: boolean): void => {
    setBusy(true);
    const done = (): void => setBusy(false);
    if (v) {
      diskApi.createLink(itemId, expiry ? Date.now() + expiry * 86_400_000 : undefined).then((r) => {
        setUrl(r.url);
        const cur = useDisk.getState().items[itemId];
        if (cur && r.link) useDisk.getState().upsert({ ...cur, link: r.link });
        done();
      }, (e: unknown) => {
        toast.fail(e, t('disk.err.link'));
        done();
      });
    } else {
      diskApi.deleteLink(itemId).then(() => {
        setUrl('');
        const cur = useDisk.getState().items[itemId];
        if (cur) useDisk.getState().upsert({ ...cur, link: undefined });
        done();
      }, (e: unknown) => {
        toast.fail(e, t('disk.err.link'));
        done();
      });
    }
  };
  const until = item.link?.expiresAt ? timestampDate(item.link.expiresAt) : null;
  return (
    <div className="flex flex-col gap-4" data-testid="disk-link">
      <Switch checked={on} onChange={toggle} label={t('disk.link.on')} hint={t(isFolder(item) ? 'disk.link.hintFolder' : 'disk.link.hint')} disabled={busy} />
      {on ? (
        <>
          <div className="flex items-center gap-2">
            <Input readOnly value={url} aria-label={t('disk.link.address')} className="font-mono text-caption" onFocus={(e) => e.currentTarget.select()} data-testid="disk-link-url" />
            <Button
              variant="secondary"
              disabled={!url}
              onClick={() =>
                void navigator.clipboard.writeText(url).then(
                  () => toast.success(t('disk.link.copied')),
                  (e: unknown) => toast.fail(e),
                )
              }
              data-testid="disk-link-copy"
            >
              <Copy className="size-3.5" aria-hidden />
              {t('disk.link.copyShort')}
            </Button>
          </div>
          <p className="text-caption text-muted">
            {until ? t('disk.link.until', { date: fmt.stamp(until) }) : t('disk.link.forever')}
            {' · '}
            {t('disk.link.downloads', { n: item.link?.downloads ?? 0 })}
          </p>
        </>
      ) : (
        <label className="flex items-center justify-between gap-4 text-body">
          <span>{t('disk.link.expiry')}</span>
          <span className="w-40 max-w-[50%] shrink-0">
            <Select value={String(expiry)} onChange={(e) => setExpiry(Number(e.target.value) as Expiry)} data-testid="disk-link-expiry">
              {EXPIRY_DAYS.map((d) => (
                <option key={d} value={d}>
                  {d === 0 ? t('disk.link.never') : t('disk.link.days', { n: d })}
                </option>
              ))}
            </Select>
          </span>
        </label>
      )}
    </div>
  );
}
