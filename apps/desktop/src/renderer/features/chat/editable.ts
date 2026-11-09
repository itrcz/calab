import { isMessageAuthor, type Message } from '@calaba/protocol';

/**
 * «Изменить» in the message menu: my own message, or one of my own bot's (isMessageAuthor,
 * ADR-0162: `myBots` = READY.my_bot_ids). Stickers, forwarded copies and system messages are
 * never edited (the server refuses them). The client only hides the item; the server decides.
 */
export function mayEditMessage(m: Pick<Message, 'authorId' | 'sticker' | 'forward' | 'system'>, own: boolean, me: string, myBots: ReadonlySet<string>): boolean {
  if (m.sticker || m.forward || m.system) return false;
  return own || isMessageAuthor(m, me, myBots);
}
