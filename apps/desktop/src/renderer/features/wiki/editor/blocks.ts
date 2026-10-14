import type { ChainedCommands, Editor } from '@tiptap/core';
import type { MessageKey } from '../../../i18n';
import { t } from '../../../i18n';

export type BlockId = 'text' | 'h1' | 'h2' | 'h3' | 'bullet' | 'ordered' | 'task' | 'quote' | 'divider' | 'code' | 'table' | 'image' | 'callout' | 'toggle';

export interface BlockDef {
  id: BlockId;
  label: MessageKey;
  /** Extra search words (English + markdown shortcut), matched with the localized label. */
  keys: string;
  /** The markdown shortcut shown in the menu (`#`, `-`, …). */
  hint?: string;
  /** Can turn the current text block into this (bubble menu «Превратить в»). */
  turnInto: boolean;
  run: (c: ChainedCommands) => ChainedCommands;
}

export const BLOCKS: readonly BlockDef[] = [
  { id: 'text', label: 'wiki.block.text', keys: 'text paragraph p', turnInto: true, run: (c) => c.setParagraph() },
  { id: 'h1', label: 'wiki.block.h1', keys: 'heading h1 title', hint: '#', turnInto: true, run: (c) => c.setHeading({ level: 1 }) },
  { id: 'h2', label: 'wiki.block.h2', keys: 'heading h2 subtitle', hint: '##', turnInto: true, run: (c) => c.setHeading({ level: 2 }) },
  { id: 'h3', label: 'wiki.block.h3', keys: 'heading h3', hint: '###', turnInto: true, run: (c) => c.setHeading({ level: 3 }) },
  { id: 'bullet', label: 'wiki.block.bullet', keys: 'bullet list ul', hint: '-', turnInto: true, run: (c) => c.toggleBulletList() },
  { id: 'ordered', label: 'wiki.block.ordered', keys: 'numbered ordered list ol', hint: '1.', turnInto: true, run: (c) => c.toggleOrderedList() },
  { id: 'task', label: 'wiki.block.task', keys: 'todo task checklist checkbox', hint: '[]', turnInto: true, run: (c) => c.toggleTaskList() },
  { id: 'quote', label: 'wiki.block.quote', keys: 'quote blockquote', hint: '>', turnInto: true, run: (c) => c.toggleBlockquote() },
  { id: 'code', label: 'wiki.block.code', keys: 'code snippet pre', hint: '```', turnInto: true, run: (c) => c.toggleCodeBlock() },
  { id: 'callout', label: 'wiki.block.callout', keys: 'callout note info tip', turnInto: true, run: (c) => c.setCallout() },
  { id: 'toggle', label: 'wiki.block.toggle', keys: 'toggle details collapse fold', turnInto: true, run: (c) => c.setToggle() },
  { id: 'divider', label: 'wiki.block.divider', keys: 'divider hr rule line', hint: '---', turnInto: false, run: (c) => c.setHorizontalRule() },
  { id: 'table', label: 'wiki.block.table', keys: 'table grid', turnInto: false, run: (c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }) },
  { id: 'image', label: 'wiki.block.image', keys: 'image picture photo img', turnInto: false, run: (c) => c.pickImage() },
];

/** Blocks for a `/` query: label words or keys start with it (any of the query's words). */
export function filterBlocks(query: string, list: readonly BlockDef[] = BLOCKS): BlockDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...list];
  return list.filter((b) => {
    const words = `${t(b.label)} ${b.keys} ${b.hint ?? ''}`.toLowerCase().split(/\s+/);
    return words.some((w) => w.startsWith(q)) || t(b.label).toLowerCase().includes(q);
  });
}

/** The block the selection is in, for the «Превратить в» button label. */
export function currentBlock(editor: Editor): BlockId {
  if (editor.isActive('heading', { level: 1 })) return 'h1';
  if (editor.isActive('heading', { level: 2 })) return 'h2';
  if (editor.isActive('heading', { level: 3 })) return 'h3';
  if (editor.isActive('taskList')) return 'task';
  if (editor.isActive('bulletList')) return 'bullet';
  if (editor.isActive('orderedList')) return 'ordered';
  if (editor.isActive('codeBlock')) return 'code';
  if (editor.isActive('callout')) return 'callout';
  if (editor.isActive('toggle')) return 'toggle';
  if (editor.isActive('blockquote')) return 'quote';
  return 'text';
}
