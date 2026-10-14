import { fromJson, type JsonValue } from '@bufbuild/protobuf';
import { PayerSchemaSchema, PayerType, payerFields } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import schemaJson from '../../../../../../proto/testdata/billing_payer_schema.json';
import { PAYER_FIELD_KEYS, countryList, defaultCountry, fieldHint, fieldTitle, problemKey, reasonText } from './payer';

const schema = fromJson(PayerSchemaSchema, schemaJson as JsonValue);
const field = (country: string, type: PayerType, key: string) => {
  const f = payerFields(schema, country, type)?.find((x) => x.key === key);
  if (!f) throw new Error(`${country} ${type} ${key}`);
  return f;
};

describe('payer form texts (ADR-0080 §0.1)', () => {
  it('labels every requisite of the served schema', () => {
    const keys = new Set([...schema.countries, ...(schema.fallback ? [schema.fallback] : [])].flatMap((c) => c.types.flatMap((t) => t.fields.map((f) => f.key))));
    for (const k of keys) expect(PAYER_FIELD_KEYS, k).toContain(k);
  });

  it('hints the format: digits, code length, VAT prefix; free text has none', () => {
    expect(fieldHint(field('RU', PayerType.COMPANY, 'inn'))).toBe('10 цифр');
    expect(fieldHint(field('RU', PayerType.SOLE_PROPRIETOR, 'ogrnip'))).toBe('15 цифр');
    expect(fieldHint(field('RU', PayerType.COMPANY, 'kpp'))).toBe('9 символов');
    expect(fieldHint(field('DE', PayerType.COMPANY, 'vat'))).toBe('Код страны DE можно не вводить');
    expect(fieldHint(field('RU', PayerType.COMPANY, 'legal_address'))).toBeUndefined();
    expect(fieldTitle(field('RU', PayerType.PERSON, 'inn'))).toBe('ИНН (необязательно)');
    expect(fieldTitle(field('RU', PayerType.COMPANY, 'inn'))).toBe('ИНН');
  });

  it('maps server fields and reasons', () => {
    expect(problemKey('payer.requisites.inn')).toBe('inn');
    expect(problemKey('payer.name')).toBe('payer.name');
    expect(reasonText('PAYER_CHECKSUM')).toBe('Номер с ошибкой — проверьте цифры');
    expect(reasonText('PAYER_REQUIRED', 'payer.name')).toBe('Укажите имя или название');
    expect(reasonText('SOMETHING_NEW')).toBe('Неверный формат');
  });

  it('names and sorts the countries in the UI language', () => {
    const ru = countryList(schema.allCountries, 'ru');
    expect(ru).toHaveLength(249);
    expect(ru.find((c) => c.code === 'DE')?.name).toBe('Германия');
    expect(ru.find((c) => c.code === 'DE')?.search).toContain('Germany');
    expect(ru.findIndex((c) => c.code === 'AT')).toBeLessThan(ru.findIndex((c) => c.code === 'RU'));
    expect(countryList(schema.allCountries, 'es').find((c) => c.code === 'DE')?.name).toBe('Alemania');
    expect(countryList(schema.allCountries, 'zh-CN').find((c) => c.code === 'DE')?.name).toBe('德国');
  });

  it('preselects a country without tying it to the market', () => {
    const all = schema.allCountries;
    expect(defaultCountry('ru', 'en', ['en-US'], all)).toBe('RU');
    expect(defaultCountry('global', 'en', ['en-GB', 'en'], all)).toBe('GB');
    expect(defaultCountry('global', 'ru', ['ru'], all)).toBe('RU');
    expect(defaultCountry('global', 'zh-CN', [], all)).toBe('CN');
    expect(defaultCountry('global', 'es', ['x-bogus-tag-'], all)).toBe('ES');
  });
});
