import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Footer } from '@/components/footer';
import { Header } from '@/components/header';
import { Container } from '@/components/ui';
import { getDict, isLocale, localePath } from '@/i18n';
import { isLegalDocument, getLegalDocuments, LEGAL_IDS, LEGAL_VERSION } from '@/lib/legal';

type Params = Promise<{ locale: string; document: string }>;

export const dynamicParams = false;
export const generateStaticParams = () => LEGAL_IDS.map((document) => ({ document }));

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, document } = await params;
  if (!isLocale(locale) || !isLegalDocument(document)) return {};
  const { title, description } = getLegalDocuments(locale)[document];
  const language = locale === 'ru' ? 'ru' : 'en';
  const canonical = localePath(language, `legal/${document}/`);
  return {
    title: `${title} — Calab`,
    description,
    // Distinct suppliers, not translations of the same agreement.
    alternates: { canonical, languages: { [language]: canonical } },
    openGraph: { title, description, url: canonical, locale: language === 'ru' ? 'ru_RU' : 'en_US', alternateLocale: [] },
    twitter: { title, description },
  };
}

export default async function LegalPage({ params }: { params: Params }) {
  const { locale, document } = await params;
  if (!isLocale(locale) || !isLegalDocument(document)) notFound();
  const t = getDict(locale);
  const documents = getLegalDocuments(locale);
  const content = documents[document];
  const ru = locale === 'ru';
  return (
    <>
      <div className="print:hidden"><Header t={t.header} locale={locale} page={`legal/${document}/`} /></div>
      <main id="main" lang={ru ? 'ru' : 'en'} className="py-12 sm:py-20 print:py-0">
        <Container>
          <article className="mx-auto max-w-[840px] break-words" aria-labelledby="legal-title">
            <p className="text-[13px] font-medium tracking-wide text-fg-2">{ru ? 'CALAB · ПРАВОВЫЕ ДОКУМЕНТЫ' : 'CALAB GLOBAL · LEGAL · ENGLISH'}</p>
            <h1 id="legal-title" className="mt-4 text-[32px] leading-tight font-semibold tracking-tight sm:text-[44px]">{content.title}</h1>
            <p className="mt-4 text-[14px] text-fg-2">{ru ? 'Редакция от ' : 'Updated '}<time dateTime={LEGAL_VERSION}>{ru ? '9 октября 2026 года' : '9 October 2026'}</time> · {ru ? 'Суточные тарифы' : 'Daily pricing edition'}</p>
            <p className="mt-6 text-[17px] leading-7 text-fg-2">{content.description}</p>
            <nav aria-label={ru ? 'Разделы документа' : 'Document sections'} className="my-8 rounded-2xl border border-line p-5 print:hidden">
              <ol className="space-y-2 text-[14px] leading-6">
                {content.sections.map((section, index) => (
                  <li key={section.title}><a className="link" href={`#section-${index + 1}`}>{section.title}</a></li>
                ))}
              </ol>
            </nav>
            <div className="space-y-10">
              {content.sections.map((section, index) => (
                <section key={section.title} id={`section-${index + 1}`} className="scroll-mt-28" aria-labelledby={`heading-${index + 1}`}>
                  <h2 id={`heading-${index + 1}`} className="mb-4 text-[21px] leading-8 font-semibold">{section.title}</h2>
                  <div className="space-y-4 text-[16px] leading-7">
                    {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
                  </div>
                </section>
              ))}
            </div>
            <aside className="mt-12 border-t border-line pt-6 text-[14px] leading-6">
              <p>{ru ? 'Поддержка: ' : 'Support: '}<a className="link" href="mailto:support@calab.io">support@calab.io</a></p>
              <nav aria-label={ru ? 'Другие правовые документы' : 'Other legal documents'} className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
                {LEGAL_IDS.filter((id) => id !== document).map((id) => (
                  <a className="link" key={id} href={localePath(locale, `legal/${id}/`)}>{documents[id].title}</a>
                ))}
              </nav>
            </aside>
          </article>
        </Container>
      </main>
      <div className="print:hidden"><Footer t={t.footer} locale={locale} /></div>
    </>
  );
}
