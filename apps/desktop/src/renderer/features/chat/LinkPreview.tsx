import type { UnfurlResponse } from '@calaba/protocol';
import { Lock, X } from 'lucide-react';
import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { MediaImg } from '../../components/MediaImg';
import { Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { isSafeHref } from '../../lib/markdown/parse';
import { openContentLink } from '../../services/contentLink';
import { peekUnfurl, unfurl } from '../../services/chat';
import { ownBoardLink } from '../../lib/ownBoardLink';
import { useSession } from '../../stores/session';
import { TaskLinkCard } from '../boards/TaskLinkCard';
import { hostOf, siteColor, siteKey } from './siteColor';

/** Server-proxied images only: never load third-party hosts from the client (proto/unfurl.proto). */
const isProxied = (p: string): boolean => p.startsWith('/api/unfurl/image');

/** Retries of a preview picture that failed to load (CBF-176) and the pause before each, ms. */
const IMAGE_RETRY_MS = [3000, 8000];

/**
 * The picture of a preview. The server proxies the page's og:image, which a site may still be
 * generating when a bot's message has just landed (GitHub renders commit cards on first request):
 * the first load fails, and an <img> never retries by itself — the card stayed broken until the row
 * was remounted by scrolling. Retry a couple of times, with the attempt in the URL so it is not
 * the failed response again.
 */
function PreviewImage({ path }: { path: string }): ReactNode {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!failed) return;
    const delay = IMAGE_RETRY_MS[attempt];
    if (delay === undefined) return;
    const id = window.setTimeout(() => {
      setFailed(false);
      setAttempt((n) => n + 1);
    }, delay);
    return () => window.clearTimeout(id);
  }, [failed, attempt]);
  return (
    <MediaImg
      key={attempt}
      path={attempt ? `${path}${path.includes('?') ? '&' : '?'}r=${attempt}` : path}
      onFail={() => setFailed(true)}
      alt=""
      loading="lazy"
      draggable={false}
      className="block aspect-[1.91/1] w-full rounded-[var(--radius-row)] bg-[color-mix(in_srgb,var(--bubble-accent)_12%,transparent)] object-cover"
    />
  );
}

/**
 * Telegram-like link preview inside a bubble (docs/09 #51): a left bar in the site's colour,
 * site name, the title as a link, description, image. Whoever may hide it (the author or
 * MANAGE_MESSAGES) gets «×» on hover / keyboard focus.
 */
export function LinkPreview({ url, onHide }: { url: string; onHide?: (() => void) | undefined }): ReactNode {
  // undefined while loading; null = nothing to show (the server had no preview, or no access).
  // An answer already in is drawn on the first render: a remounted row keeps its height (#313).
  const [got, setGot] = useState<{ url: string; card: UnfurlResponse | null } | null>(null);
  const card = got?.url === url ? got.card : peekUnfurl(url);
  useEffect(() => {
    if (peekUnfurl(url) !== undefined) return;
    let alive = true;
    void unfurl(url).then((c) => {
      if (alive) setGot({ url, card: c });
    });
    return () => {
      alive = false;
    };
  }, [url]);
  if (card === undefined) return null;
  // Our own /t/ and /b/ links (ADR-0042): the task / board card, opened in the app.
  if (card?.task || card?.board) return <TaskLinkCard res={card} href={url} />;
  // One the viewer cannot open (a private board, addendum 2026-10-14): no title, no preview — just say so.
  const own = ownBoardLink(url, useSession.getState().serverUrl);
  if (own) {
    return (
      <div className="mt-1.5 flex min-w-0 max-w-[400px] items-center gap-1.5 rounded-[var(--radius-row)] border-l-[3px] border-l-[var(--color-fill-hover)] bg-[var(--color-fill)] py-1.5 pl-2 pr-2 text-body text-muted" data-testid="task-link-unavailable">
        <Lock className="size-3.5 shrink-0" aria-hidden />
        {t(own === 'task' ? 'boards.taskUnavailable' : 'boards.boardUnavailable')}
      </div>
    );
  }
  if (!card) return null;
  const href = card.url && isSafeHref(card.url) ? card.url : url;
  const image = card.imageUrl && isProxied(card.imageUrl) ? card.imageUrl : '';
  const site = card.siteName || hostOf(href);
  // Same path as links in message text: our in-app routes open in the app, other safe links in the browser.
  const open = (e: MouseEvent): void => {
    e.preventDefault();
    if (isSafeHref(href)) openContentLink(href);
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
          <PreviewImage path={image} />
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
