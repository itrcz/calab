import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DocsShell } from '@/components/docs-shell';
import { isLocale } from '@/i18n';
import { docPath, getDocs } from '@/lib/docs';
import { docsMetadata } from '@/lib/docs-meta';
import { docLang, docsUi, UNTRANSLATED_NOTICE } from '@/lib/docs-ui';

type Params = Promise<{ locale: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const lang = docLang(locale);
  const ui = docsUi(lang);
  return docsMetadata({ locale, url: '', title: ui.title, description: ui.description, languages: ['ru', 'en'], contentLang: lang });
}

/** Docs home: every section with its pages. */
export default async function DocsHome({ params }: { params: Params }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const site = await getDocs();
  const lang = docLang(locale);
  const ui = docsUi(lang);
  const notice = UNTRANSLATED_NOTICE[locale];
  return (
    <DocsShell site={site} locale={locale} current="" page="docs/">
      <article className="docs-article" lang={lang}>
        {notice !== undefined && <p className="docs-notice">{notice}</p>}
        <h1 className="docs-h1">{ui.title}</h1>
        <p className="docs-lead">{ui.description}</p>
        <ul className="docs-cards">
          {site.nav.map((s) => {
            const index = site.page(locale, s.slug);
            return (
              <li key={s.slug}>
                <a href={docPath(locale, s.slug)} className="docs-card">
                  <span className="docs-card-title">{s.section[lang]}</span>
                  <span className="docs-card-text">{index?.entry.frontmatter.description ?? s.pages.map((p) => p[lang]).join(' · ')}</span>
                  <span className="docs-card-meta">{ui.pagesCount(s.pages.length)}</span>
                </a>
              </li>
            );
          })}
        </ul>
      </article>
    </DocsShell>
  );
}
