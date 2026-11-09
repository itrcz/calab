import { create } from '@bufbuild/protobuf';
import { ForwardSchema, StickerSchema, SystemMessageSchema, type Message } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { mayEditMessage } from './editable';

const me = 'me';
const bots = new Set(['bot1']);
type Row = Pick<Message, 'authorId' | 'sticker' | 'forward' | 'system'>;
const msg = (authorId: string, extra: Omit<Row, 'authorId'> = {}): Row => ({ authorId, ...extra });

describe('mayEditMessage (ADR-0162)', () => {
  it('opens my messages and my bot’s, not anyone else’s', () => {
    expect(mayEditMessage(msg(me), true, me, bots)).toBe(true);
    expect(mayEditMessage(msg('bot1'), false, me, bots)).toBe(true);
    expect(mayEditMessage(msg('bot2'), false, me, bots)).toBe(false);
    expect(mayEditMessage(msg('bob'), false, me, new Set())).toBe(false);
  });

  it('never stickers, forwarded copies or system messages', () => {
    expect(mayEditMessage(msg('bot1', { sticker: create(StickerSchema, {}) }), false, me, bots)).toBe(false);
    expect(mayEditMessage(msg(me, { forward: create(ForwardSchema, {}) }), true, me, bots)).toBe(false);
    expect(mayEditMessage(msg('bot1', { system: create(SystemMessageSchema, {}) }), false, me, bots)).toBe(false);
  });
});
