import type { UnfurlResponse } from '@calaba/protocol';
import { X } from 'lucide-react';
import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { MediaImg } from '../../components/MediaImg';
import { Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { isSafeHref } from '../../lib/markdown/parse';
import { platform } from '../../platform';
import { unfurl } from '../../services/chat';
import { hostOf, siteColor, siteKey } from './siteColor';

/** Server-proxied images only: never load third-party hosts from the client (proto/unfurl.proto). */
const isProxied = (p: string): boolean => p.startsWith('/api/unfurl/image');

/**
 * Telegram-like link preview inside a bubble (docs/09 #51): a left bar in the site's colour,
 * site name, the title as a link, description, image. Whoever may hide it (the author or
 * MANAGE_MESSAGES) gets «×» on hover / keyboard focus.
 */
export function LinkPreview({ url, onHide }: { url: string; onHide?: (() => void) | undefined }): ReactNode {
  const [card, setCard] = useState<UnfurlResponse | null>(null);
  useEffect(() => {
    let alive = true;
    void unfurl(url).then((c) => {
      if (alive) setCard(c);
    });
    return () => {
      alive = false;
    };
  }, [url]);
  if (!card) return null;
  const href = card.url && isSafeHref(card.url) ? card.url : url;
  const image = card.imageUrl && isProxied(card.imageUrl) ? card.imageUrl : '';
  const site = card.siteName || hostOf(href);
  // Same path as links in message text: only safe schemes, opened by the OS browser.
  const open = (e: MouseEvent): void => {
    e.preventDefault();
    if (isSafeHref(href)) void platform.app.openExternal(href);
  };
  const link = 'rounded-[4px] outline-offset-0 hover:underline';
  return (
    <div
      data-testid="link-preview"
      className="group/embed relative mt-1.5 flex min-w-0 max-w-[400px] flex-col rounded-[var(--radius-row)] border-l-[3px] bg-[color-mix(in_srgb,var(--bubble-accent)_10%,transparent)] py-1.5 pl-2 pr-2"
      style={{ borderLeftColor: siteColor(siteKey(href, card.siteName)) }}
    >
      {card.title ? (
        <span className={cx('truncate text-body font-semibold text-[color:var(--bubble-accent)]', onHide && 'pr-6')}>{site}</span>
      ) : (
        <a href={href} title={href} onClick={open} className={cx(link, 'truncate text-body font-semibold text-[color:var(--bubble-accent)]', onHide && 'mr-6')}>
          {site}
        </a>
      )}
      {card.title ? (
        <a href={href} title={href} onClick={open} className={cx(link, 'line-clamp-2 text-body font-semibold leading-5 text-fg')}>
          {card.title}
        </a>
      ) : null}
      {card.description ? <span className="selectable line-clamp-3 text-body leading-[18px] text-fg">{card.description}</span> : null}
      {image ? (
        // The picture opens the page too (mouse convenience; the title is the keyboard stop).
        <a href={href} onClick={open} tabIndex={-1} aria-hidden className="mt-1.5 block">
          <MediaImg
            path={image}
            alt=""
            loading="lazy"
            draggable={false}
            className="block aspect-[1.91/1] w-full rounded-[var(--radius-row)] bg-[color-mix(in_srgb,var(--bubble-accent)_12%,transparent)] object-cover"
          />
        </a>
      ) : null}
      {onHide ? (
        <Tip label={t('chat.embedHide')}>
          <button
            type="button"
            aria-label={t('chat.embedHide')}
            onClick={onHide}
            data-testid="link-preview-hide"
            className="absolute right-1 top-1 grid size-6 place-items-center rounded-full text-[color:var(--bubble-meta)] opacity-0 transition-opacity duration-[var(--motion-fast)] hover:bg-[color-mix(in_srgb,var(--bubble-accent)_16%,transparent)] hover:text-fg focus-visible:opacity-100 group-hover/embed:opacity-100"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </Tip>
      ) : null}
    </div>
  );
}
