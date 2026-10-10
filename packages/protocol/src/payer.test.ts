import { fromJson } from '@bufbuild/protobuf';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PayerFieldCheck, PayerSchemaSchema, PayerType } from './gen/calaba/v1/billing_pb.js';
import { checkPayer, normalizeRequisite, payerChecksum, payerFields, payerTypes } from './payer.js';

const read = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../../proto/testdata/${name}`, import.meta.url), 'utf8'));

interface Vectors {
  checks: { check: keyof typeof PayerFieldCheck | string; value: string; ok: boolean }[];
  payers: {
    name: string;
    in: { type: string; name: string; country: string; email: string; taxId?: string; requisites?: Record<string, string> };
    out?: { name: string; country: string; email: string; taxId: string; requisites: Record<string, string> };
    error?: { field: string; reason: string };
  }[];
}

const vectors = read('billing_payer_vectors.json') as Vectors;
// The schema the server serves (pinned by apps/server/internal/billing/payer TestSchemaGolden).
const schema = fromJson(PayerSchemaSchema, read('billing_payer_schema.json') as never);
const typeOf = (s: string): PayerType => PayerType[s.replace(/^PAYER_TYPE_/, '') as keyof typeof PayerType];

describe('payer requisites (shared vectors with Go internal/billing/payer)', () => {
  it.each(vectors.checks)('$check($value) = $ok', ({ check, value, ok }) => {
    const c = PayerFieldCheck[check.replace(/^PAYER_FIELD_CHECK_/, '') as keyof typeof PayerFieldCheck];
    expect(payerChecksum(c, value)).toBe(ok);
  });

  it.each(vectors.payers)('$name', (v) => {
    const { payer, problems } = checkPayer(schema, {
      type: typeOf(v.in.type),
      name: v.in.name,
      country: v.in.country,
      email: v.in.email,
      taxId: v.in.taxId ?? '',
      requisites: v.in.requisites ?? {},
    });
    if (v.error) {
      expect(problems[0]).toEqual(v.error);
      expect(payer).toBeNull();
    } else {
      expect(problems).toEqual([]);
      expect(payer).toMatchObject(v.out ?? {});
      expect(payer?.requisites).toEqual(v.out?.requisites);
    }
  });

  it('offers a sole proprietor only in RU / KZ / BY and falls back for the rest', () => {
    expect(payerTypes(schema, 'RU')).toContain(PayerType.SOLE_PROPRIETOR);
    expect(payerTypes(schema, 'DE')).not.toContain(PayerType.SOLE_PROPRIETOR);
    expect(payerFields(schema, 'BR', PayerType.COMPANY)?.map((f) => f.key)).toEqual(['tax_id']);
    expect(payerFields(schema, 'DE', PayerType.SOLE_PROPRIETOR)).toBeNull();
    expect(schema.allCountries).toHaveLength(249);
  });

  it('every example of the schema passes its own checks', () => {
    for (const c of [...schema.countries, ...(schema.fallback ? [schema.fallback] : [])]) {
      for (const t of c.types) {
        for (const f of t.fields) {
          if (!f.example) continue;
          const r = checkPayer(schema, {
            type: t.type,
            name: 'X',
            country: c.country || 'BR',
            email: 'a@b.c',
            requisites: Object.fromEntries(t.fields.map((g) => [g.key, g.example || 'Somewhere 1'])),
          });
          expect(r.problems, `${c.country} ${t.type}`).toEqual([]);
          expect(normalizeRequisite(f, c.country, f.example)).not.toBe('');
        }
      }
    }
  });
});
