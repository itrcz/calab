import * as DialogP from '@radix-ui/react-dialog';
import { ChevronLeft, ChevronRight, Download, MessageSquare } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode, type SyntheticEvent } from 'react';
import { useMediaUrl } from '../../components/MediaImg';
import { CloseButton, IconButton, Spinner, cx } from '../../components/ui';
import { t } from '../../i18n';
import { filePath, thumbnailPath } from '../../lib/api/endpoints';
import { platform } from '../../platform';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { dimsOf, fitFrame, isTap, lightboxLayers, stepImage, type Dims, type LightboxImage, type LoadState } from '../../lib/lightbox';

const onDark = 'text-[color:var(--color-on-accent)] hover:bg-[rgb(255_255_255/14%)] hover:text-[color:var(--color-on-accent)]';

/**
 * Full-window image viewer (issue #7): opens at once with the chat thumbnail and a spinner over it,
 * the full file replaces it when loaded, fitted whole into the window (never cropped or zoomed).
 * Name + download + close; ←/→ step through the images of the message; a click outside, a click on
 * the image itself (not the end of a drag, docs/09 #132) or Esc closes.
 */
export function Lightbox({ images, index: start, onClose, onShowInChat }: { images: LightboxImage[]; index: number; onClose: () => void; onShowInChat?: () => void }): ReactNode {
  const [index, setIndex] = useState(start);
  const os = useSession((s) => s.appInfo?.platform);
  // Where the press began: a drag from the image released over the backdrop is not a backdrop click
  // (the click then targets their common ancestor).
  const pressedOn = useRef<EventTarget | null>(null);
  const img = images[index] ?? images[0];
  if (!img) return null;
  const step = (delta: -1 | 1): void => {
    const next = stepImage(index, delta, images.length);
    if (next !== null) setIndex(next);
  };
  const closeOnBackdrop = (e: MouseEvent): void => {
    if (e.target === e.currentTarget && pressedOn.current === e.target) onClose();
  };
  const download = (): void =>
    void platform.files.download({ fileId: img.fileId, name: img.name }).then(
      () => toast.success(t('chat.downloaded', { name: img.name })),
      (e: unknown) => toast.fail(e, t('err.ctx.download')),
    );
  const gallery = images.length > 1;
  const electron = platform.kind === 'electron';
  const mac = electron && os === 'darwin';
  return (
    <DialogP.Root open onOpenChange={(o) => !o && onClose()}>
      <DialogP.Portal>
        <DialogP.Overlay className="no-drag anim-in fixed inset-0 z-[var(--z-modal)] bg-[rgb(0_0_0/82%)]" />
        <DialogP.Content aria-modal="true"
          data-testid="lightbox"
          className="anim-in fixed inset-0 z-[var(--z-modal)] flex flex-col focus:outline-none"
          // Focus the viewer itself (not the first button: its tooltip would swallow the first Esc).
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement | null)?.focus();
          }}
          onKeyDown={(e) => {
            if (!gallery || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
            e.preventDefault();
            step(e.key === 'ArrowLeft' ? -1 : 1);
          }}
          onPointerDownCapture={(e) => {
            pressedOn.current = e.target;
          }}
          onClick={closeOnBackdrop}
        >
          {/* The window's title bar row (Electron): a drag region, the macOS traffic lights' 80 px
              kept clear, Windows' caption buttons (env(titlebar-area-*)) too — like TitleBar. */}
          <div
            className={cx(
              'flex shrink-0 items-center gap-2 px-4 text-[color:var(--color-on-accent)]',
              electron ? 'drag h-[var(--titlebar-height)]' : 'h-12',
              mac && 'pl-[80px]',
            )}
            style={electron ? { paddingRight: 'calc(16px + 100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw))' } : undefined}
          >
            <DialogP.Title className="min-w-0 flex-1 truncate text-body font-medium" title={img.name}>
              {img.name}
            </DialogP.Title>
            {gallery ? <span className="shrink-0 text-caption tabular-nums opacity-75">{`${index + 1} / ${images.length}`}</span> : null}
            <DialogP.Description className="sr-only">{img.name}</DialogP.Description>
            {/* Opened from a search hit (ADR-0062 §4): the message carrying the file. */}
            {onShowInChat ? (
              <IconButton label={t('search.showInChat')} onClick={onShowInChat} className={onDark}>
                <MessageSquare className="size-5" />
              </IconButton>
            ) : null}
            <IconButton label={t('lightbox.download')} onClick={download} className={onDark}>
              <Download className="size-5" />
            </IconButton>
            <DialogP.Close asChild>
              <CloseButton label={t('lightbox.close')} size="md" className={onDark} />
            </DialogP.Close>
          </div>
          <div className="relative flex min-h-0 flex-1 items-center" onClick={closeOnBackdrop}>
            {gallery ? (
              <IconButton label={t('lightbox.prev')} onClick={() => step(-1)} disabled={index === 0} className={cx('z-[1] ml-2 shrink-0', onDark)}>
                <ChevronLeft className="size-6" />
              </IconButton>
            ) : null}
            <ImageStage key={img.fileId} img={img} onBackdrop={closeOnBackdrop} onClose={onClose} />
            {gallery ? (
              <IconButton label={t('lightbox.next')} onClick={() => step(1)} disabled={index === images.length - 1} className={cx('z-[1] mr-2 shrink-0', onDark)}>
                <ChevronRight className="size-6" />
              </IconButton>
            ) : null}
          </div>
        </DialogP.Content>
      </DialogP.Portal>
    </DialogP.Root>
  );
}

/**
 * One image: a frame sized to the image fitted into the stage (a size container, so the frame's
 * width can use cqw/cqh), the thumbnail under a spinner until the full file has loaded.
 */
function ImageStage({
  img,
  onBackdrop,
  onClose,
}: {
  img: LightboxImage;
  onBackdrop: (e: MouseEvent) => void;
  onClose: () => void;
}): ReactNode {
  const [thumb, setThumb] = useState<LoadState>('loading');
  const [full, setFull] = useState<LoadState>('loading');
  const [thumbAspect, setThumbAspect] = useState<Dims | null>(null);
  const [natural, setNatural] = useState<Dims | null>(null);
  const thumbSrc = useMediaUrl(thumbnailPath(img.fileId));
  const fullSrc = useMediaUrl(filePath(img.fileId), () => setFull('error'));
  const known = dimsOf(img.width, img.height) ?? natural;
  const frame = fitFrame(known ?? thumbAspect, !!known);
  const layers = lightboxLayers(thumb, full);
  // A click on the image closes like the backdrop; a press that moved (a drag) does not.
  const down = useRef<{ x: number; y: number } | null>(null);
  const onFrameDown = (e: PointerEvent): void => {
    down.current = e.isPrimary ? { x: e.clientX, y: e.clientY } : null;
  };
  const onFrameClick = (e: MouseEvent): void => {
    const from = down.current;
    down.current = null;
    if (e.button === 0 && from && isTap(from, { x: e.clientX, y: e.clientY })) onClose();
  };

  const onThumb = (e: SyntheticEvent<HTMLImageElement>): void => {
    setThumbAspect(dimsOf(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight));
    setThumb('loaded');
  };
  // An image from the memory cache can be complete before React's load listener runs.
  const thumbRef = useRef<HTMLImageElement>(null);
  useLayoutEffect(() => {
    const th = thumbRef.current;
    if (th?.complete && th.naturalWidth) {
      setThumbAspect(dimsOf(th.naturalWidth, th.naturalHeight));
      setThumb('loaded');
    }
  }, [thumbSrc]);
  // The full file loads (and decodes) off-document; the <img> appears once it can paint whole.
  useEffect(() => {
    if (!fullSrc) return;
    let alive = true;
    const pre = new Image();
    pre.src = fullSrc;
    pre.decode().then(
      () => {
        if (!alive) return;
        setNatural(dimsOf(pre.naturalWidth, pre.naturalHeight));
        setFull('loaded');
      },
      () => {
        if (alive) setFull('error');
      },
    );
    return () => {
      alive = false;
    };
  }, [fullSrc]);

  return (
    <div className="grid min-w-0 flex-1 self-stretch place-items-center px-6 pb-6 [container-type:size] mobile:px-2" onClick={onBackdrop}>
      <div
        data-testid="lightbox-frame"
        data-state={full}
        onPointerDown={onFrameDown}
        onClick={onFrameClick}
        className={cx('relative cursor-zoom-out overflow-hidden', frame && 'rounded-[var(--radius-card)] shadow-[var(--shadow-popover)]')}
        style={frame ?? { width: '100cqw', height: '100cqh' }}
      >
        {thumbSrc ? (
          <img
            ref={thumbRef}
            src={thumbSrc}
            alt=""
            aria-hidden
            draggable={false}
            onLoad={onThumb}
            className={cx('absolute inset-0 size-full object-contain', !layers.thumb && 'invisible')}
          />
        ) : null}
        {fullSrc && layers.full ? (
          <img src={fullSrc} alt={img.name} draggable={false} data-testid="lightbox-image" className="absolute inset-0 size-full object-contain" />
        ) : null}
        {layers.spinner ? (
          <span className="absolute inset-0 grid place-items-center">
            <span className="grid size-12 place-items-center rounded-full bg-[rgb(0_0_0/50%)]">
              <Spinner className="size-6 text-[color:var(--color-on-accent)]" label={t('lightbox.loading')} />
            </span>
          </span>
        ) : null}
        {layers.error ? (
          <span className="absolute inset-0 grid place-items-center p-3">
            <span role="alert" className="rounded-full bg-[rgb(0_0_0/60%)] px-3 py-1.5 text-caption text-[color:var(--color-on-accent)]">
              {t('lightbox.failed')}
            </span>
          </span>
        ) : null}
      </div>
    </div>
  );
}
