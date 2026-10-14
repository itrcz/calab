/**
 * The phone's formatting bar (ADR-0096 §7, docs/08 «Вики: телефон»): a strip right above the
 * keyboard — bold / italic / strike, H1 / H2, bullet / numbered / check list, quote, code, and a
 * fixed «+» that opens the block menu as a card. Targets are 44 px, a tap gives the `tap` haptic;
 * the editor keeps the focus (mousedown is not default-handled), so the keyboard stays up. Shown
 * only while the editor has the focus; it subscribes to booleans, so a keystroke re-renders it
 * only when a mark flips. Lives in the editor chunk (portalled into the page's slot).
 */
import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { Bold, CheckSquare, Code2, Heading1, Heading2, Italic, List, ListOrdered, Plus, Quote, Strikethrough, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '../../../components/ui';
import { t, type MessageKey } from '../../../i18n';
import { haptics } from '../../../lib/haptics';

interface Tool {
  id: string;
  label: MessageKey;
  Icon: LucideIcon;
  active: (e: Editor) => boolean;
  run: (e: Editor) => void;
}

const TOOLS: readonly Tool[] = [
  { id: 'bold', label: 'wiki.mark.bold', Icon: Bold, active: (e) => e.isActive('bold'), run: (e) => void e.chain().focus().toggleBold().run() },
  { id: 'italic', label: 'wiki.mark.italic', Icon: Italic, active: (e) => e.isActive('italic'), run: (e) => void e.chain().focus().toggleItalic().run() },
  { id: 'strike', label: 'wiki.mark.strike', Icon: Strikethrough, active: (e) => e.isActive('strike'), run: (e) => void e.chain().focus().toggleStrike().run() },
  { id: 'h1', label: 'wiki.block.h1', Icon: Heading1, active: (e) => e.isActive('heading', { level: 1 }), run: (e) => void e.chain().focus().toggleHeading({ level: 1 }).run() },
  { id: 'h2', label: 'wiki.block.h2', Icon: Heading2, active: (e) => e.isActive('heading', { level: 2 }), run: (e) => void e.chain().focus().toggleHeading({ level: 2 }).run() },
  { id: 'bullet', label: 'wiki.block.bullet', Icon: List, active: (e) => e.isActive('bulletList'), run: (e) => void e.chain().focus().toggleBulletList().run() },
  { id: 'ordered', label: 'wiki.block.ordered', Icon: ListOrdered, active: (e) => e.isActive('orderedList'), run: (e) => void e.chain().focus().toggleOrderedList().run() },
  { id: 'task', label: 'wiki.block.task', Icon: CheckSquare, active: (e) => e.isActive('taskList'), run: (e) => void e.chain().focus().toggleTaskList().run() },
  { id: 'quote', label: 'wiki.block.quote', Icon: Quote, active: (e) => e.isActive('blockquote'), run: (e) => void e.chain().focus().toggleBlockquote().run() },
  { id: 'code', label: 'wiki.block.code', Icon: Code2, active: (e) => e.isActive('codeBlock'), run: (e) => void e.chain().focus().toggleCodeBlock().run() },
];

export function PhoneToolbar({ editor, onBlocks }: { editor: Editor; onBlocks: () => void }): ReactNode {
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      focused: e.isFocused,
      on: TOOLS.map((tool) => (tool.active(e) ? '1' : '0')).join(''),
    }),
  });
  if (!st.focused) return null;
  return (
    <div className="mat-toolbar flex shrink-0 items-stretch border-t border-line" role="toolbar" aria-label={t('wiki.phone.toolbar')} data-testid="wiki-phone-toolbar">
      {/* Scrolls (10 tools do not fit at 390 px): snap to buttons, the last 16 px fade out as the «more» cue; pr-4 keeps the final button clear of the fade. */}
      <div className="scrollbar-none fade-end flex min-w-0 flex-1 snap-x snap-proximity overflow-x-auto pr-4">
        {TOOLS.map((tool, i) => {
          const on = st.on[i] === '1';
          return (
          <button
            key={tool.id}
            type="button"
            aria-label={t(tool.label)}
            aria-pressed={on}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              haptics.tap();
              tool.run(editor);
            }}
            className={cx('grid h-11 w-11 shrink-0 snap-start place-items-center', on ? 'text-accent-text' : 'text-fg')}
            data-testid={`wiki-tool-${tool.id}`}
          >
            <tool.Icon className="size-5" strokeWidth={on ? 2.25 : 1.75} aria-hidden />
          </button>
          );
        })}
      </div>
      <button
        type="button"
        aria-label={t('wiki.phone.addBlock')}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          haptics.tap();
          onBlocks();
        }}
        className="grid h-11 w-12 shrink-0 place-items-center border-l border-line text-accent-text"
        data-testid="wiki-tool-add"
      >
        <Plus className="size-6" strokeWidth={2} aria-hidden />
      </button>
    </div>
  );
}
