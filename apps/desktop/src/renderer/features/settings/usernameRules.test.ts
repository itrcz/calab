import { describe, expect, it } from 'vitest';
import { normalizeUsername, phoneProblem, usernameProblem } from './usernameRules';

describe('nickname rules (ADR-0077)', () => {
  it('normalizes like the server', () => {
    expect(normalizeUsername('  @Ivan_P ')).toBe('ivan_p');
    expect(normalizeUsername('')).toBe('');
  });

  it('format and reserved names', () => {
    for (const ok of ['ivan', 'ivan_petrov', 'a12', 'a'.repeat(32), '']) expect(usernameProblem(ok), ok).toBeNull();
    for (const bad of ['ab', '1ivan', '_ivan', 'ivan-p', 'ivan.p', 'иван', 'a'.repeat(33)]) expect(usernameProblem(bad), bad).toBe('invalid');
    for (const r of ['admin', 'everyone', 'here', 'calab', 'bot']) expect(usernameProblem(r), r).toBe('reserved');
  });
});

describe('phone rules (ADR-0077)', () => {
  it('accepts numbers with + ( ) - and spaces, clears with empty', () => {
    for (const ok of ['+7 (999) 123-45-67', '8-800-555-35-35', '  +7   999 123 ', '']) expect(phoneProblem(ok), ok).toBe(false);
    for (const bad of ['abc', '+7+999', '12', '999 ext 1', '+1 234 567 890 123 456 789 012 34']) expect(phoneProblem(bad), bad).toBe(true);
  });
});
