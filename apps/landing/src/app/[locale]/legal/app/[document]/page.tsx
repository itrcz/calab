import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Container } from '@/components/ui';
import { isLocale, localePath, type Locale } from '@/i18n';
import { getLegalDocuments, APP_LEGAL_IDS, isAppLegalDocument, LEGAL_VERSION } from '@/lib/legal';

type Params = Promise<{ locale: string; document: string }>;

/** `/<locale>/legal/app/<document>/`: a static route, not `?app=1` on the public page (#139) — the
 * public page needs client JS to hide its header, which would flash it on first paint. */
const appLegalPath = (locale: Locale, document: string): string => `${localePath(locale, 'legal/app/')}${document}/`;

export const dynamicParams = false;
export const generateStaticParams = () => APP_LEGAL_IDS.map((document) => ({ document }));

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, document } = await params;
  if (!isLocale(locale) || !isAppLegalDocument(document)) return {};
  const { title, description } = getLegalDocuments(locale)[document];
  return {
    title: `${title} — Calab`,
    description,
    // Not a page for search engines or the public nav (#139): it exists only for the native shell.
    robots: { index: false, follow: false },
  };
}

/**
 * The app-mode legal page (#139, docs/adr/0148): the same document text as `/legal/<document>/`,
 * but no landing header/footer and no links to pricing, the public offer or «Оплата и возврат» —
 * a store reviewer who follows «О программе» → privacy/terms from the native shell must not reach
 * prices or a purchase flow in one or two taps. Support contact and links between the other
 * app-mode documents stay; `offer` and `payments` (APP_LEGAL_IDS) are not generated here at all, so
 * even a guessed URL 404s.
 */
export default async function AppLegalPage({ params }: { params: Params }) {
  const { locale, document } = await params;
  if (!isLocale(locale) || !isAppLegalDocument(document)) notFound();
  const documents = getLegalDocuments(locale);
  const content = documents[document];
  const ru = locale === 'ru';
  return (
    <main id="main" lang={ru ? 'ru' : 'en'} className="py-12 sm:py-20">
      <Container>
        <article className="mx-auto max-w-[840px] break-words" aria-labelledby="legal-title">
          <p className="text-[13px] font-medium tracking-wide text-fg-2">{ru ? 'CALAB · ПРАВОВЫЕ ДОКУМЕНТЫ' : 'CALAB GLOBAL · LEGAL · ENGLISH'}</p>
          <h1 id="legal-title" className="mt-4 text-[32px] leading-tight font-semibold tracking-tight sm:text-[44px]">{content.title}</h1>
          <p className="mt-4 text-[14px] text-fg-2">{ru ? 'Редакция от ' : 'Updated '}<time dateTime={LEGAL_VERSION}>{ru ? '9 октября 2026 года' : '9 October 2026'}</time></p>
          <p className="mt-6 text-[17px] leading-7 text-fg-2">{content.description}</p>
          <div className="mt-8 space-y-10">
            {content.sections.map((section, index) => (
              <section key={section.title} id={`section-${index + 1}`} aria-labelledby={`heading-${index + 1}`}>
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
              {APP_LEGAL_IDS.filter((id) => id !== document).map((id) => (
                <a className="link" key={id} href={appLegalPath(locale, id)}>{documents[id].title}</a>
              ))}
            </nav>
          </aside>
        </article>
      </Container>
    </main>
  );
}
