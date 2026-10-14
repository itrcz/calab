// llms.txt / llms-full.txt (ADR-0099 §1 SEO): the hand-written product text in src/content/llms*.txt
// plus the developer docs generated from the same Markdown as the site, so the two never drift.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDocs, urlOf } from './docs';
import { resolveDocLink } from './docs-markdown';
import { SITE_URL } from './site';

const base = (name: string): string => readFileSync(join(process.cwd(), 'src/content', name), 'utf8');
const url = (path: string): string => `${SITE_URL}/en/docs/${path === '' ? '' : `${path}/`}`;

/** One heading level down (pages sit under `## <title>`), outside fenced code. */
function demote(md: string): string {
  let fence = false;
  return md.split('\n').map((line) => {
    if (/^(?:```|~~~)/.test(line)) fence = !fence;
    return !fence && /^#{1,5} /.test(line) ? `#${line}` : line;
  }).join('\n');
}

/** Relative docs links → absolute English URLs (the file is read outside the site). */
const absolute = (md: string, slug: string): string =>
  md.replace(/\]\(([^)\s]+)\)/g, (m, href: string) => {
    const t = resolveDocLink(slug, href);
    return t === null ? m : `](${url(urlOf(t.slug))}${t.anchor === null ? '' : `#${t.anchor}`})`;
  });

export async function llmsTxt(): Promise<string> {
  const site = await getDocs();
  const pages = site.markdown('en');
  const list = site.nav.map((s) => [
    `### ${s.section.en}`,
    '',
    ...pages.filter((p) => p.url === s.slug || p.url.startsWith(`${s.slug}/`)).map((p) => `- [${p.title}](${url(p.url)}): ${p.description}`),
  ].join('\n')).join('\n\n');
  return base('llms.txt').replace('{{DOCS}}', `## Developer documentation\n\n${list}`);
}

export async function llmsFullTxt(): Promise<string> {
  const site = await getDocs();
  const body = site.markdown('en')
    .map((p) => `## ${p.title}\n\nURL: ${url(p.url)}\n\n${p.description}\n\n${absolute(demote(p.body), p.slug)}`)
    .join('\n\n');
  return base('llms-full.txt').replace('{{DOCS}}', `# Developer documentation (English)\n\n${body}`);
}

export const textResponse = (text: string): Response =>
  new Response(text.endsWith('\n') ? text : `${text}\n`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
