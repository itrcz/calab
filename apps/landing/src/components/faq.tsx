import { Plus } from 'lucide-react';
import type { Dict } from '@/i18n';
import { rich } from '@/lib/rich';
import { CONTACT_FORM_URL } from '@/lib/site';
import { Section, SectionHeading } from './ui';

const ORDER = ['server', 'identity', 'recording', 'sip', 'security', 'firewall', 'enterprise', 'buy'] as const;

export function Faq({ t }: { t: Dict['faq'] }) {
  const contact = (
    <a href={CONTACT_FORM_URL} className="link">
      {t.contactLink}
    </a>
  );
  return (
    <Section id="faq" labelledBy="faq-title" alt>
      <div className="sticker-section-heading">
      <SectionHeading id="faq-title" eyebrow={t.eyebrow} title={t.title} />
        <img className="section-sticker" src="/editorial/sticker-faq.webp" width={180} height={180} alt="" loading="lazy" />
      </div>
      <div className="faq-grid">
        {ORDER.map((id) => (
          <details key={id} className={`faq-card ${id === 'identity' ? 'faq-card-blue' : id === 'server' || id === 'enterprise' ? 'faq-card-light' : ''}`}>
            <summary className="faq-question">
              <h3>{t.items[id].q}</h3>
              <span className="faq-toggle" aria-hidden="true"><Plus size={20} strokeWidth={1.75} /></span>
            </summary>
            <div className="faq-answer"><p>{rich(t.items[id].a, { contact })}</p></div>
          </details>
        ))}
      </div>
    </Section>
  );
}
