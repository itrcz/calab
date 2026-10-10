import type { Metadata } from 'next';
import { OnpayResult } from '@/components/onpay-result';
import { ONPAY_COPY } from '@/i18n/onpay';

export const metadata: Metadata = { title: `${ONPAY_COPY.fail.ru.title} — Calab` };

export default function Page() {
  return <OnpayResult kind="fail" />;
}
