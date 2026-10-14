import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DocsShell } from '@/components/docs-shell';
import { isLocale, type Locale } from '@/i18n';
import { docPath, getDocs, localizeHtml, type DocsSite } from '@/lib/docs';
import { docsMetadata } from '@/lib/docs-meta';
import { docLang, docsUi, UNTRANSLATED_NOTICE } from '@/lib/docs-ui';
import { REPO_URL } from '@/lib/site';

type Params = Promise<{ locale: string; slug: string[] }>;

export const dynamicParams = false;
// Every section and page under every locale ([locale]/layout.tsx supplies the locales).
export async function generateStaticParams() {
  const site = await getDocs();
  return site.urls.map((url) => ({ slug: url.split('/') }));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, slug } = await params;
  if (!isLocale(locale)) return {};
  const site = await getDocs();
  const url = slug.join('/');
  const p = site.page(locale, url);
  const lang = docLang(locale);
  if (p !== null) {
    const { title, description } = p.entry.frontmatter;
    return docsMetadata({ locale, url, title, description, languages: p.languages, contentLang: p.entry.lang });
  }
  const section = site.nav.find((s) => s.slug === url);
  if (section === undefined) return {};
  return docsMetadata({ locale, url, title: section.section[lang], description: docsUi(lang).description, languages: ['ru', 'en'], contentLang: lang });
}

export default async function DocsPage({ params }: { params: Params }) {
  const { locale, slug } = await params;
  if (!isLocale(locale)) notFound();
  const site = await getDocs();
  const url = slug.join('/');
  const p = site.page(locale, url);
  if (p === null) return <SectionIndex site={site} locale={locale} url={url} />;
  const ui = docsUi(p.ui);
  const { entry } = p;
  const updated = new Intl.DateTimeFormat(p.ui === 'ru' ? 'ru-RU' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(entry.lastModified));
  const toc = entry.toc.length > 1 ? (
    <aside className="docs-toc" aria-labelledby="docs-toc-title">
      <p id="docs-toc-title" className="docs-toc-title">{ui.onThisPage}</p>
      <ul>
        {entry.toc.map((h) => (
          <li key={h.id} className={h.depth === 3 ? 'is-h3' : undefined}>
            <a href={`#${encodeURIComponent(h.id)}`} data-toc={h.id}>{h.text}</a>
          </li>
        ))}
      </ul>
    </aside>
  ) : undefined;
  return (
    <DocsShell site={site} locale={locale} current={p.url} page={`docs/${p.url}/`} aside={toc}>
      <nav aria-label={ui.breadcrumbs} className="docs-crumbs">
        <ol>
          <li><a href={docPath(locale, '')}>{ui.docs}</a></li>
          <li>{p.url === p.section.slug ? <span aria-current="page">{p.section.title}</span> : <a href={docPath(locale, p.section.slug)}>{p.section.title}</a>}</li>
          {p.url !== p.section.slug && <li><span aria-current="page">{p.label}</span></li>}
        </ol>
      </nav>
      <article className="docs-article" lang={entry.lang}>
        {p.notice !== null && <p className="docs-notice" lang={p.ui}>{p.notice}</p>}
        <h1 className="docs-h1">{entry.frontmatter.title}</h1>
        <p className="docs-lead">{entry.frontmatter.description}</p>
        <div className="docs-prose" dangerouslySetInnerHTML={{ __html: localizeHtml(entry.html, locale) }} />
      </article>
      <footer className="docs-page-foot">
        <p>
          {ui.updated}: <time dateTime={entry.lastModified}>{updated}</time>
          {' · '}
          <a className="link" href={`${REPO_URL}/edit/main/${entry.path}`}>{ui.edit}</a>
        </p>
        <nav className="docs-pager" aria-label={`${ui.prev} / ${ui.next}`}>
          {p.prev !== null ? (
            <a href={docPath(locale, p.prev.url)} rel="prev" className="docs-pager-link">
              <span>{ui.prev}</span><strong>{p.prev.title}</strong>
            </a>
          ) : <span />}
          {p.next !== null && (
            <a href={docPath(locale, p.next.url)} rel="next" className="docs-pager-link is-next">
              <span>{ui.next}</span><strong>{p.next.title}</strong>
            </a>
          )}
        </nav>
      </footer>
    </DocsShell>
  );
}

/** A section without its own index.md: the list of its pages. */
function SectionIndex({ site, locale, url }: { site: DocsSite; locale: Locale; url: string }) {
  const section = site.nav.find((s) => s.slug === url);
  if (section === undefined) notFound();
  const lang = docLang(locale);
  const ui = docsUi(lang);
  const notice = UNTRANSLATED_NOTICE[locale];
  return (
    <DocsShell site={site} locale={locale} current={url} page={`docs/${url}/`}>
      <nav aria-label={ui.breadcrumbs} className="docs-crumbs">
        <ol>
          <li><a href={docPath(locale, '')}>{ui.docs}</a></li>
          <li><span aria-current="page">{section.section[lang]}</span></li>
        </ol>
      </nav>
      <article className="docs-article" lang={lang}>
        {notice !== undefined && <p className="docs-notice">{notice}</p>}
        <h1 className="docs-h1">{section.section[lang]}</h1>
        <h2 className="sr-only">{ui.pages}</h2>
        <ul className="docs-cards">
          {section.pages.filter((pg) => pg.slug !== 'index').map((pg) => {
            const page = site.page(locale, `${url}/${pg.slug}`);
            return (
              <li key={pg.slug}>
                <a href={docPath(locale, `${url}/${pg.slug}`)} className="docs-card">
                  <span className="docs-card-title">{pg[lang]}</span>
                  {page !== null && <span className="docs-card-text">{page.entry.frontmatter.description}</span>}
                </a>
              </li>
            );
          })}
        </ul>
      </article>
    </DocsShell>
  );
}

