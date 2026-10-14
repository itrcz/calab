import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { str } from '../../../lib/wiki/markdown';
import { memo, type ReactNode } from 'react';
import { MediaImg } from '../../../components/MediaImg';
import { t } from '../../../i18n';
import { EmojiPicker } from '../../chat/EmojiPicker';
import type { EditorEnv } from './env';

const envOf = (p: ReactNodeViewProps): EditorEnv | null => (p.extension.options as { env?: EditorEnv | null }).env ?? null;

/** Callout: an emoji (picked with the chat's EmojiPicker) and the body. */
export const CalloutView = memo(function CalloutView(p: ReactNodeViewProps): ReactNode {
  const icon = str(p.node.attrs['icon'], '💡');
  const editable = p.editor.isEditable;
  const glyph = (
    <span className="wiki-callout-icon" aria-hidden={!editable}>
      {icon}
    </span>
  );
  return (
    <NodeViewWrapper className="wiki-callout" data-callout="">
      <span contentEditable={false} className="wiki-callout-side">
        {editable ? (
          <EmojiPicker label={t('wiki.callout.icon')} closeOnPick onPick={(e) => p.updateAttributes({ icon: e })}>
            <button type="button" className="wiki-callout-btn" aria-label={t('wiki.callout.icon')}>
              {glyph}
            </button>
          </EmojiPicker>
        ) : (
          glyph
        )}
      </span>
      <NodeViewContent className="wiki-callout-body" />
    </NodeViewWrapper>
  );
});

/** Image by file id through the app's media URL helper; the box keeps the aspect ratio before load. */
export const ImageView = memo(function ImageView(p: ReactNodeViewProps): ReactNode {
  const env = envOf(p);
  const fileId = str(p.node.attrs['fileId'], '');
  const w = Number(p.node.attrs['width']) || undefined;
  const h = Number(p.node.attrs['height']) || undefined;
  const alt = str(p.node.attrs['alt'], '') || t('wiki.image.alt');
  const path = fileId && env ? env.imagePath(fileId) : '';
  return (
    <NodeViewWrapper className="wiki-image" data-selected={p.selected || undefined} data-drag-handle="">
      {path ? (
        <MediaImg
          path={path}
          alt={alt}
          width={w}
          height={h}
          loading="lazy"
          decoding="async"
          draggable={false}
          className="wiki-image-img"
          style={w && h ? { aspectRatio: `${w} / ${h}` } : undefined}
        />
      ) : null}
    </NodeViewWrapper>
  );
});
