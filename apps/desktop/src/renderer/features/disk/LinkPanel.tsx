import { timestampDate } from '@bufbuild/protobuf/wkt';
import type { DiskItem } from '@calaba/protocol';
import { Copy } from 'lucide-react';
import { useEffect, useState, type ReactNode, type SyntheticEvent } from 'react';
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
 * on (changing it means a new link), the download counter; while on, the password and «Без
 * скачивания» (ADR-0167, `LinkProtection`). One body for «Ссылка» (the dialog) and the file card
 * (CBF-20); the caller decides who may see it (the owner, «Управление» or DISK_MANAGE).
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
  // The hint promises a download only while the link allows one (ADR-0167).
  const viewOnly = !!item.link?.viewOnly;
  const hint = isFolder(item) ? (viewOnly ? 'disk.link.hintFolderViewOnly' : 'disk.link.hintFolder') : viewOnly ? 'disk.link.hintViewOnly' : 'disk.link.hint';
  return (
    <div className="flex flex-col gap-4" data-testid="disk-link">
      <Switch checked={on} onChange={toggle} label={t('disk.link.on')} hint={t(hint)} disabled={busy} />
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
          <LinkProtection item={item} />
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

/** Puts the link of a PATCH answer on the item in the store. */
function keepLink(itemId: string, link: DiskItem['link']): void {
  const cur = useDisk.getState().items[itemId];
  if (cur && link) useDisk.getState().upsert({ ...cur, link });
}

/**
 * The password and «Без скачивания» of a live link (ADR-0167). The password is never shown: only
 * whether one is set; «Задать» / «Изменить» open a field in place, «Убрать» removes it. Every
 * change ends the visitors' unlocks (the server bumps the link's password version).
 */
function LinkProtection({ item }: { item: DiskItem }): ReactNode {
  const link = item.link;
  const [editing, setEditing] = useState(false);
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  if (!link) return null;
  const tooShort = Array.from(pw).length < 4;
  const patch = (init: { password?: string; viewOnly?: boolean }, ok?: string): void => {
    setBusy(true);
    diskApi.updateLink(item.id, init).then(
      (r) => {
        keepLink(item.id, r.link);
        setBusy(false);
        setEditing(false);
        setPw('');
        if (ok) toast.success(ok);
      },
      (e: unknown) => {
        toast.fail(e, t('disk.err.link'));
        setBusy(false);
      },
    );
  };
  const save = (e: SyntheticEvent): void => {
    e.preventDefault();
    if (!tooShort && !busy) patch({ password: pw }, t('disk.link.passwordSaved'));
  };
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-3" data-testid="disk-link-protection">
      <div className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-4 mobile:items-center">
          <span className="flex min-w-0 flex-col">
            <span className="text-body">{t('disk.link.password')}</span>
            <span className="text-caption text-faint" data-testid="disk-link-password-state">
              {link.hasPassword ? t('disk.link.passwordOn') : t('disk.link.passwordOff')}
            </span>
          </span>
          {!editing ? (
            <span className="flex shrink-0 gap-2">
              {link.hasPassword ? (
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => patch({ password: '' }, t('disk.link.passwordRemoved'))} data-testid="disk-link-password-remove">
                  {t('disk.link.passwordRemove')}
                </Button>
              ) : null}
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => setEditing(true)} data-testid="disk-link-password-edit">
                {link.hasPassword ? t('disk.link.passwordChange') : t('disk.link.passwordSet')}
              </Button>
            </span>
          ) : null}
        </div>
        {editing ? (
          <form className="flex items-center gap-2" onSubmit={save}>
            <Input
              type="password"
              autoFocus
              autoComplete="new-password"
              value={pw}
              maxLength={128}
              onChange={(e) => setPw(e.target.value)}
              placeholder={t('disk.link.passwordPlaceholder')}
              aria-label={t('disk.link.password')}
              data-testid="disk-link-password-input"
            />
            <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={() => {
                setEditing(false);
                setPw('');
              }}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" size="sm" className="shrink-0" disabled={tooShort} busy={busy} data-testid="disk-link-password-save">
              {t('common.save')}
            </Button>
          </form>
        ) : null}
      </div>
      <Switch checked={link.viewOnly} onChange={(v) => patch({ viewOnly: v })} label={t('disk.link.viewOnly')} hint={t('disk.link.viewOnlyHint')} disabled={busy} />
    </div>
  );
}
