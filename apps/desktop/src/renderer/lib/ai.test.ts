import { create } from '@bufbuild/protobuf';
import { AiProvider, AiSettingsSchema, AiState } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AI_MODEL, draftError, draftOf, fieldErrorKey, keyApplies, normalizeBaseUrl, reasonKey, requestOf, smartErrorRef, smartErrorText, smartOffKey, tabOf, validBaseUrl } from './ai';

describe('smart task (CBF-68)', () => {
  it('is on only when READY, with the reason otherwise', () => {
    expect(smartOffKey(AiState.READY)).toBeNull();
    expect(smartOffKey(AiState.NO_KEY)).toBe('smart.off.noKey');
    expect(smartOffKey(AiState.UNSPECIFIED)).toBe('smart.off.noKey');
    expect(smartOffKey(AiState.UNCHECKED)).toBe('smart.off.unchecked');
    expect(smartOffKey(AiState.FAILED)).toBe('smart.off.failed');
    expect(smartOffKey(undefined)).toBe('smart.off.loading');
  });
  it('CBF-69: off on a plan without AI (Free / Team), whatever the AI state', () => {
    for (const st of [AiState.READY, AiState.NO_KEY, AiState.FAILED, undefined]) expect(smartOffKey(st, false)).toBe('smart.off.plan');
    expect(smartOffKey(AiState.READY, true)).toBeNull();
    expect(smartOffKey(AiState.UNCHECKED, true)).toBe('smart.off.unchecked');
    expect(smartErrorText({ status: 409, reason: 'AI_PLAN_REQUIRED', message: '' })?.key).toBe('smart.off.plan');
  });
  it('explains a refusal', () => {
    expect(smartErrorText({ status: 409, reason: 'AI_BAD_ANSWER', message: '' })?.key).toBe('smart.err.badAnswer');
    expect(smartErrorText({ status: 409, reason: 'AI_FAILED', message: 'insufficient_balance' })).toEqual({ key: 'smart.err.failed', reason: 'ai.reason.insufficient_balance' });
    expect(smartErrorText({ status: 409, reason: 'NO_BOARDS', message: '' })?.key).toBe('smart.err.noBoards');
    expect(smartErrorText({ status: 409, reason: 'AI_NOT_READY', message: '' })?.key).toBe('smart.err.notReady');
    expect(smartErrorText({ status: 429, message: '' })?.key).toBe('smart.err.rate');
    expect(smartErrorText({ status: 422, field: 'text', message: '' })?.key).toBe('smart.err.text');
  });
  it('bug #152: a timeout says the task may exist; other failures fall back to the generic cause', () => {
    expect(smartErrorText({ status: 504, message: 'request timed out' })?.key).toBe('smart.err.timeout');
    for (const status of [0, 403, 413, 500, 502, 503]) expect(smartErrorText({ status, message: '' })).toBeNull();
    expect(smartErrorText({ status: 409, reason: 'SOMETHING_NEW', message: '' })).toBeNull();
  });
  it('bug #152: the reference a person reports — code, status, request id', () => {
    expect(smartErrorRef({ code: 'ERROR_CODE_UNAVAILABLE', status: 504, requestId: 'abc123' })).toBe('UNAVAILABLE · 504 · abc123');
    expect(smartErrorRef({ code: 'ERROR_CODE_UNSPECIFIED', status: 502 })).toBe('502');
    expect(smartErrorRef({ code: 'ERROR_CODE_UNAVAILABLE', status: 0 })).toBe('UNAVAILABLE');
    expect(smartErrorRef({})).toBe('');
  });
});

const savedGpt = create(AiSettingsSchema, { provider: AiProvider.GPTUNNEL, model: 'gpt-6-astra', hasKey: true, keyMask: '••••abcd' });
const savedOai = create(AiSettingsSchema, { provider: AiProvider.OPENAI_COMPATIBLE, baseUrl: 'https://api.example.com/v1', model: 'm', hasKey: true });

describe('ai settings form', () => {
  it('opens on the saved provider, GPTunneL when never saved', () => {
    expect(tabOf(AiProvider.UNSPECIFIED)).toBe('gptunnel');
    expect(tabOf(AiProvider.OPENAI_COMPATIBLE)).toBe('openai');
    expect(draftOf(undefined, 'gptunnel')).toEqual({ baseUrl: '', key: '', model: DEFAULT_AI_MODEL });
    expect(draftOf(savedOai, 'openai')).toEqual({ baseUrl: 'https://api.example.com/v1', key: '', model: 'm' });
    expect(draftOf(savedOai, 'gptunnel').model).toBe(DEFAULT_AI_MODEL);
  });

  it('normalises and validates the API root like the server', () => {
    expect(normalizeBaseUrl(' https://api.example.com/v1/chat/completions/ ')).toBe('https://api.example.com/v1');
    expect(validBaseUrl('https://api.example.com/v1')).toBe(true);
    for (const bad of ['', 'api.example.com', 'ftp://x.y', 'https://u:p@x.y', 'https://x.y/v1?a=1']) expect(validBaseUrl(bad), bad).toBe(false);
  });

  it('keeps a saved key only for its provider and address', () => {
    expect(keyApplies(savedGpt, 'gptunnel', '')).toBe(true);
    expect(keyApplies(savedGpt, 'openai', 'https://api.example.com/v1')).toBe(false);
    expect(keyApplies(savedOai, 'openai', 'https://api.example.com/v1/')).toBe(true);
    expect(keyApplies(savedOai, 'openai', 'https://other.example.com/v1')).toBe(false);
  });

  it('reports the first problem before a request', () => {
    const d = { baseUrl: '', key: '', model: 'm' };
    expect(draftError(d, undefined, 'openai', true)?.field).toBe('baseUrl');
    expect(draftError(d, undefined, 'gptunnel', true)?.key).toBe('ai.err.key');
    expect(draftError(d, savedOai, 'gptunnel', true)?.key).toBe('ai.err.keyOther');
    expect(draftError(d, savedGpt, 'gptunnel', true)).toBeNull();
    expect(draftError(d, undefined, 'gptunnel', false)).toBeNull(); // saving without a key is allowed
    expect(draftError({ ...d, key: 'has space' }, undefined, 'gptunnel', true)?.key).toBe('ai.err.keyFormat');
    expect(draftError({ ...d, key: 'sk-1', model: ' ' }, undefined, 'gptunnel', true)?.field).toBe('model');
  });

  it('sends the key only when typed', () => {
    expect(requestOf({ baseUrl: 'x', key: '', model: ' m ' }, 'gptunnel')).toEqual({ provider: AiProvider.GPTUNNEL, baseUrl: '', model: 'm' });
    expect(requestOf({ baseUrl: ' https://a.b/v1 ', key: ' sk-1 ', model: 'm' }, 'openai')).toEqual({ provider: AiProvider.OPENAI_COMPATIBLE, baseUrl: 'https://a.b/v1', model: 'm', apiKey: 'sk-1' });
  });

  it('maps server codes to texts', () => {
    expect(reasonKey('unauthorized')).toBe('ai.reason.unauthorized');
    expect(reasonKey('something new')).toBe('ai.reason.unknown');
    expect(fieldErrorKey('apiKey', savedGpt, false)).toBe('ai.err.keyOther');
    expect(fieldErrorKey('apiKey', undefined, true)).toBe('ai.err.keyFormat');
    expect(fieldErrorKey('provider', undefined, false)).toBeNull();
  });
});
