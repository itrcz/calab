import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Footer } from '@/components/footer';
import { Header } from '@/components/header';
import { Container } from '@/components/ui';
import { getDict, isLocale, localePath } from '@/i18n';
import { isLegalDocument, LEGAL_DATE, LEGAL_DOCUMENTS, LEGAL_IDS, LEGAL_VERSION } from '@/lib/legal';

type Params = Promise<{ locale: string; document: string }>;

export const dynamicParams = false;
export const generateStaticParams = () => LEGAL_IDS.map((document) => ({ document }));

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { document } = await params;
  if (!isLegalDocument(document)) return {};
  const { title, description } = LEGAL_DOCUMENTS[document];
  const canonical = localePath('ru', `legal/${document}/`);
  return {
    title: `${title} — Calab`,
    description,
    // The navigation is localized; the legal text has one Russian original.
    alternates: { canonical, languages: { ru: canonical } },
    openGraph: { title, description, url: canonical, locale: 'ru_RU', alternateLocale: [] },
    twitter: { title, description },
  };
}

export default async function LegalPage({ params }: { params: Params }) {
  const { locale, document } = await params;
  if (!isLocale(locale) || !isLegalDocument(document)) notFound();
  const t = getDict(locale);
  const content = LEGAL_DOCUMENTS[document];
  return (
    <>
      <div className="print:hidden"><Header t={t.header} locale={locale} page={`legal/${document}/`} /></div>
      <main id="main" lang="ru" className="py-12 sm:py-20 print:py-0">
        <Container>
          <article className="mx-auto max-w-[840px] break-words" aria-labelledby="legal-title">
            <p className="text-[13px] font-medium tracking-wide text-fg-2">CALAB · ПРАВОВЫЕ ДОКУМЕНТЫ</p>
            <h1 id="legal-title" className="mt-4 text-[32px] leading-tight font-semibold tracking-tight sm:text-[44px]">{content.title}</h1>
            <p className="mt-4 text-[14px] text-fg-2">Редакция от <time dateTime={LEGAL_VERSION}>{LEGAL_DATE}</time></p>
            <p className="mt-6 text-[17px] leading-7 text-fg-2">{content.description}</p>
            <nav aria-label="Разделы документа" className="my-8 rounded-2xl border border-line p-5 print:hidden">
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
              <p>Поддержка: <a className="link" href="mailto:support@calab.io">support@calab.io</a></p>
              <nav aria-label="Другие правовые документы" className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
                {LEGAL_IDS.filter((id) => id !== document).map((id) => (
                  <a className="link" key={id} href={localePath(locale, `legal/${id}/`)}>{LEGAL_DOCUMENTS[id].title}</a>
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
