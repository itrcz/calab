import { describe, expect, it } from 'vitest';
import { viaBotSuffix, viaBotText, viaText } from './bots';

describe('the «via bot» mark (ADR-0106)', () => {
  it('names the bot after the author', () => {
    expect(viaBotText('Ассистент')).toBe('через бота Ассистент');
    expect(viaBotSuffix('Ассистент')).toBe('(через бота Ассистент)');
  });

  it('still marks the action while the bot’s name is unknown', () => {
    expect(viaBotText('')).toBe('через бота');
    expect(viaBotSuffix('  ')).toBe('(через бота)');
  });
});

describe('the «via MCP» mark (ADR-0156)', () => {
  it('marks the way: a bot, MCP or both', () => {
    expect(viaText(true, 'Агент', true)).toBe('через бота Агент · MCP');
    expect(viaText(false, '', true)).toBe('через MCP');
    expect(viaText(true, 'Агент', false)).toBe('через бота Агент');
    expect(viaText(false, '', false)).toBe('');
  });
});
