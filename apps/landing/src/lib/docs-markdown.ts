// Build-time Markdown → HTML for the developer docs (ADR-0099 §1). Runs only during `next build`
// (server components and static route handlers); nothing here reaches the browser.
//
// Pipeline: remark (GFM, YAML frontmatter, callouts, code → slots) → rehype (raw HTML, strict
// sanitize, slugs, TOC/search sections, heading anchors, relative links, table wrappers, code
// slots filled with shiki output) → HTML string. Generated markup (code blocks, tabs) is inserted
// after sanitizing, so the allowlist only has to admit what authors may write by hand.
import { posix } from 'node:path';
import type { Element, ElementContent, Root as HastRoot } from 'hast';
import { toString as hastToString } from 'hast-util-to-string';
import type { Blockquote, Code, Parent, Root as MdRoot, RootContent } from 'mdast';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from 'rehype-sanitize';
import rehypeSlug from 'rehype-slug';
import rehypeStringify from 'rehype-stringify';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { createHighlighter, type Highlighter } from 'shiki';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import { parse as parseYaml } from 'yaml';
import { docsUi, type Callout, type Decision, type DocLang } from './docs-ui';

export type BotRoute = { method: string; path: string; decision: Decision; group: string };
export type TocItem = { id: string; text: string; depth: 2 | 3 };
/** A heading section of a page for the search index: heading id ('' = top), heading text, start of its text. */
export type SearchSection = { id: string; heading: string; text: string };
/** A link to another docs page (or an anchor) found in the page, already resolved to a slug. */
export type DocLink = { raw: string; slug: string; anchor: string | null };
export type Frontmatter = { title: string; description: string; order?: number; placeholder?: boolean };
export type Rendered = {
  frontmatter: Frontmatter;
  html: string;
  toc: TocItem[];
  ids: string[];
  links: DocLink[];
  sections: SearchSection[];
  /** Source without frontmatter, route tables expanded (llms-full.txt). */
  markdown: string;
};
export type RenderContext = {
  lang: DocLang;
  /** `section/page` of the file being rendered (relative links resolve against its section). */
  slug: string;
  routes: readonly BotRoute[];
  /** URL of a docs slug ('' = docs home, `section`, `section/page`) for the rendered locale. */
  href: (slug: string, anchor: string | null) => string;
};

// ---------------------------------------------------------------------------------------------
// Route tables (DOC2 convention): `<!-- routes:<spec> -->` … hand-written GFM table … `<!-- /routes -->`.
// At build time the rows between the markers are regenerated from _routes.json (botroutes.go), so a
// new route appears without editing the page; the third column («Что делает» / «Область») is kept
// from the hand-written row with the same method + path. Specs:
//   <group>        bot routes of the group (`allow`) plus any other listed row, hand order first
//   allow:<group>  bot routes of the group
//   public | deny  every public / people-only route
// The build fails on an unknown spec, a group without routes, or a hand-written row that is no
// longer in botroutes.go. Expanded in the source text: the HTML and llms-full.txt get the same table.

const BLOCK = /^<!--[ \t]*routes:([^\s>]+)[ \t]*-->[ \t]*\n([\s\S]*?)^<!--[ \t]*\/routes[ \t]*-->[ \t]*$/gm;
const ROW = /^\|\s*`([A-Z]+)`\s*\|\s*`([^`]+)`\s*\|(.*)\|\s*$/;
const routeKey = (method: string, path: string) => `${method === '*' ? 'ANY' : method} ${path}`;

export function expandRouteBlock(spec: string, body: string, routes: readonly BotRoute[], lang: DocLang): string {
  const lines = body.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|'));
  const header = lines[0] ?? `| ${docsUi(lang).routes.method} | ${docsUi(lang).routes.path} | ${docsUi(lang).routes.bots} |`;
  const byKey = new Map(routes.map((r) => [routeKey(r.method, r.path), r]));
  const hand = new Map<string, string>();
  const stale: string[] = [];
  for (const line of lines.slice(2)) {
    const m = ROW.exec(line);
    if (!m) continue;
    const key = routeKey(m[1] ?? '', m[2] ?? '');
    if (!byKey.has(key)) stale.push(key);
    hand.set(key, (m[3] ?? '').trim());
  }
  if (stale.length > 0) throw new Error(`routes:${spec}: not in botroutes.go: ${stale.join(', ')}`);

  let selected: BotRoute[];
  const [kind, group] = spec.includes(':') ? spec.split(':') : [null, spec];
  if (spec === 'public' || spec === 'deny') selected = routes.filter((r) => r.decision === spec);
  else if (kind === 'allow') selected = routes.filter((r) => r.decision === 'allow' && r.group === group);
  else if (kind === null) selected = routes.filter((r) => r.decision === 'allow' && r.group === group);
  else throw new Error(`routes:${spec}: unknown spec (use <group>, allow:<group>, public or deny)`);
  if (selected.length === 0) throw new Error(`routes:${spec}: no routes of this group in _routes.json`);

  const keys = new Set(selected.map((r) => routeKey(r.method, r.path)));
  // `<group>` pages may list related rows of other groups (DM files on the Files page): keep them.
  const order = kind === null ? [...hand.keys(), ...[...keys].filter((k) => !hand.has(k))] : [...keys];
  const ui = docsUi(lang);
  const fallback = (r: BotRoute) => (r.decision === 'deny' ? r.group : r.decision === 'public' ? ui.decisions.public : '—');
  const rows = order.map((key) => {
    const r = byKey.get(key);
    if (r === undefined) return '';
    const [method, ...path] = key.split(' ');
    return `| \`${method ?? ''}\` | \`${path.join(' ')}\` | ${hand.get(key) || fallback(r)} |`;
  });
  return [header, '|---|---|---|', ...rows].join('\n');
}

export const expandDirectives = (source: string, routes: readonly BotRoute[], lang: DocLang): string =>
  source.replace(BLOCK, (_m, spec: string, body: string) =>
    `<!-- routes:${spec} -->\n${expandRouteBlock(spec, body, routes, lang)}\n<!-- /routes -->`);

// ---------------------------------------------------------------------------------------------
// Frontmatter

function readFrontmatter(tree: MdRoot): Frontmatter {
  const node = tree.children.find((n) => n.type === 'yaml');
  const data: unknown = node ? parseYaml(node.value) : null;
  if (typeof data !== 'object' || data === null) throw new Error('frontmatter is missing');
  const { title, description, order, placeholder } = data as Record<string, unknown>;
  if (typeof title !== 'string' || title.trim() === '') throw new Error('frontmatter: `title` is required');
  if (typeof description !== 'string' || description.trim() === '') throw new Error('frontmatter: `description` is required');
  const fm: Frontmatter = { title, description };
  if (typeof order === 'number') fm.order = order;
  if (placeholder === true) fm.placeholder = true;
  return fm;
}

// ---------------------------------------------------------------------------------------------
// Callouts: `> [!NOTE]` … → <aside class="callout callout-note" role="note"><p class="callout-title">…

const CALLOUT = /^\[!(NOTE|TIP|WARNING|DANGER)\][ \t]*\n?/i;

function remarkCallouts(lang: DocLang) {
  const labels = docsUi(lang).callouts;
  return (tree: MdRoot) => {
    visit(tree, 'blockquote', (node: Blockquote) => {
      const first = node.children[0];
      if (first?.type !== 'paragraph') return;
      const text = first.children[0];
      if (text?.type !== 'text') return;
      const m = CALLOUT.exec(text.value);
      if (!m) return;
      const kind = (m[1] ?? 'note').toLowerCase() as Callout;
      text.value = text.value.slice(m[0].length);
      if (text.value === '') first.children.shift();
      if (first.children.length === 0) node.children.shift();
      node.data = { hName: 'aside', hProperties: { className: ['callout', `callout-${kind}`], role: 'note' } };
      node.children.unshift({
        type: 'paragraph',
        data: { hProperties: { className: ['callout-title'] } },
        children: [{ type: 'text', value: labels[kind] }],
      });
    });
  };
}

// ---------------------------------------------------------------------------------------------
// Code: every fence becomes an empty `<div data-docs-slot="N">`; consecutive fences with
// `tab="…"` meta become one slot (a tab group). Slots are filled with highlighted HTML after
// sanitizing (rehypeFillSlots).

type Fence = { lang: string; code: string; tab: string | null };
type Slot = { fences: Fence[] };

const tabOf = (meta: string | null | undefined): string | null => {
  const m = /\btab=(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(meta ?? '');
  return m ? (m[1] ?? m[2] ?? m[3] ?? '').trim() || null : null;
};

function remarkCodeSlots(slots: Slot[]) {
  const slotNode = (fences: Fence[]): RootContent => {
    const index = slots.push({ fences }) - 1;
    return { type: 'docsSlot', children: [], data: { hName: 'div', hProperties: { dataDocsSlot: String(index) } } } as unknown as RootContent;
  };
  const fence = (c: Code): Fence => ({ lang: (c.lang ?? '').toLowerCase(), code: c.value, tab: tabOf(c.meta) });
  return (tree: MdRoot) => {
    const walk = (parent: Parent) => {
      const out: RootContent[] = [];
      const kids = parent.children;
      for (let i = 0; i < kids.length; i++) {
        const node = kids[i];
        if (node === undefined) continue;
        if (node.type === 'code') {
          const group = [fence(node)];
          if (group[0]?.tab !== null) {
            while (kids[i + 1]?.type === 'code' && tabOf((kids[i + 1] as Code).meta) !== null) group.push(fence(kids[++i] as Code));
          }
          out.push(slotNode(group));
          continue;
        }
        if ('children' in node) walk(node);
        out.push(node);
      }
      (parent as { children: RootContent[] }).children = out;
    };
    walk(tree);
  };
}

// ---------------------------------------------------------------------------------------------
// Sanitizing: GitHub's allowlist + what docs need by hand (inline SVG diagrams, <details>, callout
// asides from the remark step, slot markers). No scripts, styles, event handlers or iframes.

const SVG_TAGS = ['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'defs', 'marker', 'title', 'desc'];
const SVG_ATTRS = [
  'viewBox', 'width', 'height', 'fill', 'fillOpacity', 'stroke', 'strokeWidth', 'strokeDasharray', 'strokeLinecap',
  'strokeLinejoin', 'strokeOpacity', 'opacity', 'd', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'dx', 'dy', 'cx', 'cy', 'r', 'rx', 'ry',
  'points', 'transform', 'textAnchor', 'dominantBaseline', 'fontSize', 'fontFamily', 'fontWeight', 'markerEnd', 'markerStart',
  'markerWidth', 'markerHeight', 'refX', 'refY', 'orient', 'preserveAspectRatio', 'xmlns', 'role', 'ariaLabel', 'ariaHidden', 'id', 'className',
];

const SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  // Authors' ids (SVG markers, explicit anchors) are kept as written: rendered pages are ours.
  clobber: [],
  tagNames: [...(defaultSchema.tagNames ?? []), 'aside', 'figure', 'figcaption', ...SVG_TAGS],
  attributes: {
    ...defaultSchema.attributes,
    aside: [['className', 'callout', 'callout-note', 'callout-tip', 'callout-warning', 'callout-danger'], ['role', 'note']],
    p: [...(defaultSchema.attributes?.p ?? []), ['className', 'callout-title']],
    div: [...(defaultSchema.attributes?.div ?? []), ['dataDocsSlot', /^\d+$/]],
    img: [...(defaultSchema.attributes?.img ?? []), 'width', 'height', 'loading'],
    ...Object.fromEntries(SVG_TAGS.map((t) => [t, SVG_ATTRS])),
    '*': [...(defaultSchema.attributes?.['*'] ?? []), 'id'],
  },
};

// ---------------------------------------------------------------------------------------------
// Heading data: TOC (h2/h3), every id on the page (anchor check), search sections. Runs after
// rehype-slug and before the anchor links are appended (so `#` is not part of the text).

const INLINE = new Set(['a', 'abbr', 'b', 'code', 'del', 'em', 'i', 'kbd', 'mark', 'span', 'strong', 'sub', 'sup']);
/** Plain text with a space between block-level elements (table cells, list items), for search snippets. */
const plainText = (node: ElementContent): string =>
  node.type === 'text' ? node.value
    : node.type !== 'element' ? ''
      : node.children.map(plainText).join(INLINE.has(node.tagName) ? '' : ' ');

function rehypeCollect(title: string, out: { toc: TocItem[]; ids: string[]; sections: SearchSection[] }) {
  return (tree: HastRoot) => {
    visit(tree, 'element', (el: Element) => {
      if (typeof el.properties.id === 'string') out.ids.push(el.properties.id);
    });
    let current: SearchSection = { id: '', heading: title, text: '' };
    const flush = () => {
      current.text = current.text.replace(/\s+/g, ' ').trim().slice(0, 200);
      out.sections.push(current);
    };
    for (const node of tree.children) {
      if (node.type !== 'element') continue;
      const depth = node.tagName === 'h2' ? 2 : node.tagName === 'h3' ? 3 : null;
      if (depth !== null && typeof node.properties.id === 'string') {
        const text = hastToString(node).trim();
        out.toc.push({ id: node.properties.id, text, depth });
        flush();
        current = { id: node.properties.id, heading: text, text: '' };
      } else if (current.text.length < 400) {
        current.text += ` ${plainText(node)}`;
      }
    }
    flush();
  };
}

// ---------------------------------------------------------------------------------------------
// Links: relative links resolve against the page's section (`../oauth/flow`, `gateway#events`,
// `quickstart.md`), `/docs/…` is locale-relative; both are recorded for the build-time check.

const EXTERNAL = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;

export function resolveDocLink(fromSlug: string, href: string): { slug: string; anchor: string | null } | null {
  if (EXTERNAL.test(href)) return null;
  const hash = href.indexOf('#');
  const path = hash < 0 ? href : href.slice(0, hash);
  const anchor = hash < 0 ? null : decodeURIComponent(href.slice(hash + 1)) || null;
  if (path === '') return { slug: fromSlug, anchor };
  let target: string;
  if (path.startsWith('/')) {
    if (!/^\/docs(?:\/|$)/.test(path)) return null;
    target = path.slice('/docs'.length);
  } else {
    target = posix.join(posix.dirname(fromSlug), path);
  }
  target = target.replace(/\.md$/, '').replace(/^\/+|\/+$/g, '').replace(/^\.$/, '');
  return { slug: target, anchor };
}

function rehypeLinks(ctx: RenderContext, links: DocLink[]) {
  return (tree: HastRoot) => {
    visit(tree, 'element', (el: Element) => {
      if (el.tagName !== 'a' || typeof el.properties.href !== 'string') return;
      if ((el.properties.className)?.includes('docs-anchor')) return;
      const raw = el.properties.href;
      const target = resolveDocLink(ctx.slug, raw);
      if (target === null) {
        if (/^https?:/i.test(raw)) el.properties.rel = ['noopener'];
        return;
      }
      links.push({ raw, ...target });
      el.properties.href = target.slug === ctx.slug && target.anchor !== null ? `#${target.anchor}` : ctx.href(target.slug, target.anchor);
    });
  };
}

/** Wide tables scroll inside their own box, never the page. Also drops the whitespace text that
 * the HTML parser hoists out of tables (rehype-raw), so the output stays compact. */
function rehypeTables() {
  return (tree: HastRoot) => {
    tree.children = tree.children.filter((n, i, all) => !(n.type === 'text' && n.value.trim() === '' && all[i - 1]?.type === 'text'));
    visit(tree, 'element', (el: Element, index, parent) => {
      if (el.tagName !== 'table' || parent === undefined || index === undefined) return;
      parent.children[index] = { type: 'element', tagName: 'div', properties: { className: ['docs-table'], tabIndex: 0 }, children: [el] };
    });
  };
}

// ---------------------------------------------------------------------------------------------
// Code blocks: shiki at build time (inline token colours, background from the site token).

const LANGS = ['bash', 'json', 'javascript', 'typescript', 'python', 'go', 'http', 'yaml', 'powershell'] as const;
const ALIASES: Record<string, string> = {
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', curl: 'bash',
  js: 'javascript', mjs: 'javascript', ts: 'typescript', py: 'python', yml: 'yaml', jsonc: 'json', golang: 'go', ps1: 'powershell', pwsh: 'powershell',
};
const LABELS: Record<string, string> = {
  bash: 'bash', json: 'JSON', javascript: 'JavaScript', typescript: 'TypeScript', python: 'Python', go: 'Go', http: 'HTTP', yaml: 'YAML', powershell: 'PowerShell',
};
export const THEME = 'github-dark-default';

let highlighter: Promise<Highlighter> | null = null;
const getHighlighter = (): Promise<Highlighter> =>
  (highlighter ??= createHighlighter({ themes: [THEME], langs: [...LANGS], engine: createJavaScriptRegexEngine() }));

const h = (tagName: string, properties: Element['properties'], children: ElementContent[] = []): Element =>
  ({ type: 'element', tagName, properties, children });
const text = (value: string): ElementContent => ({ type: 'text', value });

function codeFigure(hl: Highlighter, f: Fence, copy: string, tabbed = false): Element {
  const lang = ALIASES[f.lang] ?? f.lang;
  const known = (LANGS as readonly string[]).includes(lang);
  const root = hl.codeToHast(f.code.replace(/\n$/, ''), { lang: known ? lang : 'text', theme: THEME });
  const pre = root.children[0] as Element;
  // Background and border come from the site tokens (.docs-code); token colours stay inline.
  pre.properties = { className: ['shiki'], tabIndex: 0 };
  // Inside a tab group the tab already names the language: no repeated label in the header.
  const label = tabbed ? '' : known ? (LABELS[lang] ?? lang) : f.lang;
  return h('figure', { className: ['docs-code'] }, [
    h('div', { className: ['docs-code-head'] }, [
      h('span', { className: ['docs-code-lang'] }, label ? [text(label)] : []),
      h('button', { type: 'button', className: ['docs-copy'], dataCopy: '' }, [text(copy)]),
    ]),
    pre,
  ]);
}

function slotHtml(hl: Highlighter, slot: Slot, index: number, lang: DocLang): Element {
  const ui = docsUi(lang);
  const [only] = slot.fences;
  if (slot.fences.length === 1 && only !== undefined && only.tab === null) return codeFigure(hl, only, ui.copy);
  const id = (k: string, i: number) => `code-${index}-${k}-${i}`;
  return h('div', { className: ['docs-tabs'], dataTabs: '' }, [
    h('div', { className: ['docs-tabs-list'], role: 'tablist', ariaLabel: ui.codeExamples },
      slot.fences.map((f, i) => h('button', {
        type: 'button', role: 'tab', id: id('tab', i), ariaControls: [id('panel', i)], ariaSelected: i === 0 ? 'true' : 'false',
        tabIndex: i === 0 ? 0 : -1, dataTab: f.tab ?? f.lang,
      }, [text(f.tab ?? f.lang)]))),
    ...slot.fences.map((f, i) => h('div', {
      role: 'tabpanel', id: id('panel', i), ariaLabelledBy: [id('tab', i)], hidden: i !== 0,
    }, [codeFigure(hl, f, ui.copy, true)])),
  ]);
}

function rehypeFillSlots(hl: Highlighter, slots: Slot[], lang: DocLang) {
  return (tree: HastRoot) => {
    visit(tree, 'element', (el: Element, index, parent) => {
      const slot = el.properties.dataDocsSlot;
      if (el.tagName !== 'div' || slot === undefined || parent === undefined || index === undefined) return;
      const n = Number(slot);
      const s = slots[n];
      if (s === undefined) return;
      parent.children[index] = slotHtml(hl, s, n, lang);
    });
  };
}

// ---------------------------------------------------------------------------------------------

/** Renders one Markdown page. Throws on invalid frontmatter or directives. */
export async function renderMarkdown(source: string, ctx: RenderContext): Promise<Rendered> {
  const hl = await getHighlighter();
  const slots: Slot[] = [];
  const links: DocLink[] = [];
  const collected = { toc: [] as TocItem[], ids: [] as string[], sections: [] as SearchSection[] };
  const md = unified().use(remarkParse).use(remarkFrontmatter, ['yaml']).use(remarkGfm);
  const expanded = expandDirectives(source, ctx.routes, ctx.lang);
  const tree = md.parse(expanded);
  const frontmatter = readFrontmatter(tree);
  const processor = unified()
    .use(remarkCallouts, ctx.lang)
    .use(remarkCodeSlots, slots)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, SCHEMA)
    .use(rehypeSlug)
    .use(rehypeCollect, frontmatter.title, collected)
    .use(rehypeAutolinkHeadings, {
      behavior: 'append',
      test: ['h2', 'h3', 'h4'],
      properties: { className: ['docs-anchor'], ariaHidden: 'true', tabIndex: -1 },
      content: { type: 'text', value: '#' },
    })
    .use(rehypeLinks, ctx, links)
    .use(rehypeTables)
    .use(rehypeFillSlots, hl, slots, ctx.lang)
    .use(rehypeStringify);
  const hast = await processor.run(tree);
  const html = processor.stringify(hast);
  const markdown = expanded.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/<!--[\s\S]*?-->\n?/g, '').trim();
  return { frontmatter, html, links, markdown, ...collected };
}
