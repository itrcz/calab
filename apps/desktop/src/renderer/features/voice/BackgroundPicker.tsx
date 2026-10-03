import { Loader2, Plus, X } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { MediaImg } from '../../components/MediaImg';
import { Segmented, Tip, cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { BUILTIN_BACKGROUNDS, addCustomBackground, listCustomBackgrounds, prepareUpload, removeCustomBackground } from '../../lib/media/background/images';
import { MAX_CUSTOM_BACKGROUNDS, SEG_FPS_OPTIONS, normalizeSegFps, type SegFpsOption, UPLOAD_TYPES, uploadProblem, workspaceImageId, type BackgroundKind, type CameraBackground } from '../../lib/media/background/logic';
import { thumbnailPath } from '../../lib/api/endpoints';
import { log } from '../../lib/log';
import { useCameraBg } from '../../stores/cameraBg';
import { usePrefs } from '../../stores/prefs';
import { toast } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { useBackgroundList } from '../../stores/workspaces';
import { backgroundBlocked, blockedText } from '../../services/cameraBackground';

/** The user's pictures as thumbnail object URLs (revoked on change / unmount). */
export function useCustomBackgrounds(): { list: { id: string; url: string }[]; reload: () => void } {
  const [list, setList] = useState<{ id: string; url: string }[]>([]);
  const [gen, setGen] = useState(0);
  useEffect(() => {
    let alive = true;
    let urls: string[] = [];
    listCustomBackgrounds().then(
      (all) => {
        if (!alive) return;
        const next = all.map((c) => ({ id: c.id, url: URL.createObjectURL(c.thumb) }));
        urls = next.map((x) => x.url);
        setList(next);
      },
      (err: unknown) => log.warn('camera backgrounds: list failed', err),
    );
    return () => {
      alive = false;
      for (const u of urls) URL.revokeObjectURL(u);
    };
  }, [gen]);
  const reload = useCallback(() => setGen((g) => g + 1), []);
  return { list, reload };
}

const same = (a: CameraBackground, kind: BackgroundKind, imageId?: string): boolean => a.kind === kind && (kind !== 'image' || a.imageId === imageId);

/**
 * «Фон» in the camera preview (ADR-0035 §5, docs/08 «Превью камеры»): blur chips, the workspace's
 * backgrounds (the addendum: the voice room's workspace, else the open one), then the built-in
 * pictures and the user's own in a 4-column grid, «+ Свой». The choice is a device preference and
 * applies at once — to the preview and to the live camera.
 */
export function BackgroundPicker(): ReactNode {
  const kind = usePrefs((s) => s.cameraBackground.kind);
  const imageId = usePrefs((s) => s.cameraBackground.imageId);
  const setPrefs = usePrefs((s) => s.setPrefs);
  const software = useCameraBg((s) => s.software);
  const hardware = useCameraBg((s) => s.hardware);
  // Checked before a choice (owner, 2.1): where it cannot run, the section is shown disabled with why.
  const failure = useCameraBg((s) => s.failure);
  const blocked = backgroundBlocked(failure);
  const locale = useLocale();
  const { list, reload } = useCustomBackgrounds();
  const voiceWs = useVoice((s) => s.workspaceId);
  const activeWs = useUi((s) => s.activeWorkspaceId);
  const workspace = useBackgroundList(voiceWs || activeWs);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const choose = useCallback((bg: CameraBackground) => setPrefs({ cameraBackground: bg }), [setPrefs]);

  const upload = async (file: File): Promise<void> => {
    const problem = uploadProblem(file, list.length);
    if (problem) {
      toast.info(problem === 'limit' ? t('video.bg.limit', { n: MAX_CUSTOM_BACKGROUNDS }) : problem === 'size' ? t('video.bg.tooBig') : t('video.bg.badType'));
      return;
    }
    setBusy(true);
    try {
      const { full, thumb } = await prepareUpload(file);
      const id = await addCustomBackground(full, thumb);
      reload();
      choose({ kind: 'image', imageId: id });
    } catch (err) {
      log.warn('camera background upload failed', err);
      toast.info(t('video.bg.uploadFailed'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string): Promise<void> => {
    await removeCustomBackground(id).catch((e: unknown) => log.warn('camera background remove failed', e));
    if (kind === 'image' && imageId === id) choose({ kind: 'none' });
    reload();
  };

  const hint = blocked ? blockedText(blocked, failure) : hardware ? t('video.bg.system') : software ? t('video.bg.software') : null;
  const full = list.length >= MAX_CUSTOM_BACKGROUNDS;
  const current: CameraBackground = { kind, ...(imageId ? { imageId } : {}) };
  return (
    <section aria-labelledby="camera-bg-title" data-testid="camera-bg">
      <h3 id="camera-bg-title" className="mb-2 text-footnote font-semibold text-muted">
        {t('video.bg.title')}
      </h3>
      <fieldset disabled={blocked !== null} aria-describedby={blocked ? 'camera-bg-blocked' : undefined} className={cx('m-0 min-w-0 border-0 p-0', blocked && 'opacity-50')} data-testid="camera-bg-choices">
        <Segmented<BackgroundKind>
          label={t('video.bg.title')}
          value={kind}
          onChange={(k) => choose({ kind: k })}
          options={[
            { value: 'none', label: t('video.bg.none') },
            { value: 'blur-light', label: t('video.bg.blurLight') },
            { value: 'blur-strong', label: t('video.bg.blurStrong') },
          ]}
        />
        {workspace.length > 0 ? (
          <>
            <h4 id="camera-bg-ws" className="mb-1.5 mt-3 text-caption text-muted">
              {t('video.bg.workspace')}
            </h4>
            <div role="radiogroup" aria-labelledby="camera-bg-ws" className="grid grid-cols-4 gap-2" data-testid="camera-bg-workspace">
              {workspace.map((b) => {
                const id = workspaceImageId(b.id);
                return <Thumb key={b.id} id={id} path={thumbnailPath(b.fileId)} label={b.name} selected={same(current, 'image', id)} onChoose={choose} />;
              })}
            </div>
            <h4 className="mb-1.5 mt-3 text-caption text-muted">{t('video.bg.builtin')}</h4>
          </>
        ) : null}
        <div role="radiogroup" aria-label={t('video.bg.pictureList')} className={cx('grid grid-cols-4 gap-2', workspace.length === 0 && 'mt-3')}>
          {BUILTIN_BACKGROUNDS.map((b) => (
            <Thumb key={b.id} id={b.id} url={b.thumbUrl} label={b.name(locale)} selected={same(current, 'image', b.id)} onChoose={choose} />
          ))}
          {list.map((c, i) => (
            <Thumb key={c.id} id={c.id} url={c.url} label={t('video.bg.custom', { n: i + 1 })} selected={same(current, 'image', c.id)} onChoose={choose} onRemove={remove} />
          ))}
          <Tip label={full ? t('video.bg.limit', { n: MAX_CUSTOM_BACKGROUNDS }) : t('video.bg.addHint')}>
            <button
              type="button"
              aria-disabled={full || busy}
              onClick={() => !full && !busy && input.current?.click()}
              className={cx(
                'flex aspect-video items-center justify-center gap-1 rounded-[var(--radius-card)] border border-dashed border-[var(--color-border-popover)] text-footnote text-muted transition-colors duration-[var(--motion-fast)]',
                full ? 'opacity-50' : 'hover:bg-hover hover:text-fg',
              )}
              data-testid="camera-bg-add"
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Plus className="size-3.5" aria-hidden />}
              {t('video.bg.add')}
            </button>
          </Tip>
        </div>
        {kind !== 'none' ? <BackgroundSmoothness hint /> : null}
        <input
          ref={input}
          type="file"
          accept={UPLOAD_TYPES.join(',')}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void upload(f);
          }}
        />
      </fieldset>
      {hint ? (
        <p id={blocked ? 'camera-bg-blocked' : undefined} className="mt-2 text-caption text-muted" data-testid={blocked ? 'camera-bg-blocked' : undefined}>
          {hint}
        </p>
      ) : null}
    </section>
  );
}

/**
 * «Плавность»: how often the mask is computed (8 · 16 · 20 · 25 per second) — a leaf with its own
 * primitive subscription; applies live (services/voice.ts, CameraPreview follow prefs.cameraBgFps).
 */
export function BackgroundSmoothness({ hint = false }: { hint?: boolean }): ReactNode {
  const fps = usePrefs((s) => s.cameraBgFps);
  const setPrefs = usePrefs((s) => s.setPrefs);
  const onChange = useCallback((v: string) => setPrefs({ cameraBgFps: normalizeSegFps(Number(v)) }), [setPrefs]);
  return (
    <div className={hint ? 'mt-3' : undefined} data-testid="camera-bg-fps">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {hint ? <span className="text-footnote text-muted">{t('video.bg.fps')}</span> : null}
        <Segmented<string> label={t('video.bg.fps')} value={String(fps)} onChange={onChange} options={SEG_FPS_OPTIONS.map((o: SegFpsOption) => ({ value: String(o), label: String(o) }))} />
        <span className="text-caption text-muted">{t('video.bg.fpsUnit')}</span>
      </div>
      {hint ? <p className="mt-1.5 text-caption text-muted">{t('video.bg.fpsHint')}</p> : null}
    </div>
  );
}

const Thumb = memo(function Thumb({
  id,
  url,
  path,
  label,
  selected,
  onChoose,
  onRemove,
}: {
  id: string;
  /** A local picture (built-in asset, object URL) … */
  url?: string;
  /** … or an API media path (a workspace background's thumbnail). */
  path?: string;
  label: string;
  selected: boolean;
  onChoose: (bg: CameraBackground) => void;
  onRemove?: (id: string) => Promise<void>;
}): ReactNode {
  return (
    <div className="group relative">
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        aria-label={label}
        title={label}
        onClick={() => onChoose({ kind: 'image', imageId: id })}
        className={cx(
          'block aspect-video w-full overflow-hidden rounded-[var(--radius-card)]',
          selected ? 'ring-2 ring-accent ring-offset-2 ring-offset-[var(--color-popover)]' : 'ring-1 ring-[var(--color-border-popover)] hover:ring-2 hover:ring-[var(--color-fill-hover)]',
        )}
      >
        {path ? <MediaImg path={path} alt="" draggable={false} data-wsbg-thumb className="size-full object-cover" /> : <img src={url} alt="" draggable={false} className="size-full object-cover" />}
      </button>
      {onRemove ? (
        <button
          type="button"
          aria-label={t('video.bg.remove')}
          title={t('video.bg.remove')}
          onClick={() => void onRemove(id)}
          className="mat-popover absolute -right-1.5 -top-1.5 hidden size-5 place-items-center rounded-full text-fg shadow-[var(--shadow-popover)] focus-visible:grid group-hover:grid"
        >
          <X className="size-3" aria-hidden />
        </button>
      ) : null}
    </div>
  );
});
