import { AudioLines, CalendarClock, Check, CircleDot, ListChecks, MessagesSquare, SquareSlash, UsersRound, Webhook, type LucideIcon } from 'lucide-react';
import type { Dict, Locale } from '@/i18n';
import { localePath } from '@/i18n/locales';
import { getMcp } from '@/i18n/mcp';
import { rich } from '@/lib/rich';
import { BOT_EXAMPLES_URL, BOT_SDK_URL } from '@/lib/site';
import { BotCode } from './bot-code';
import { McpSnippet } from './ai-section';
import { getPageCopy } from '@/i18n/pages';
import { SectionCta } from './section-cta';
import { Button, Card, Container, Section, SectionHeading } from './ui';

type CardId = keyof Dict['bots']['cards'];
const CARDS: { id: CardId; icon: LucideIcon }[] = [
  { id: 'chat', icon: MessagesSquare },
  { id: 'tasks', icon: ListChecks },
  { id: 'voice', icon: AudioLines },
  { id: 'calendar', icon: CalendarClock },
  { id: 'people', icon: UsersRound },
  { id: 'recording', icon: CircleDot },
  { id: 'commands', icon: SquareSlash },
  { id: 'webhook', icon: Webhook },
];

function Points({ items }: { items: string[] }) {
  return (
    <ul className="check-list">
      {items.map((p) => (
        <li key={p}>
          <Check aria-hidden="true" size={18} strokeWidth={2.25} />
          <span>{p}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * /<locale>/developers/ (§4 «Другие страницы»): bots, MCP, SDK, webhooks and «Sign in with Calab» on one page,
 * each with a link into the docs. Replaces /bots/ (Caddy 301) and the MCP block of the old home page.
 */
export function DevelopersPage({ locale, bots }: { locale: Locale; bots: Dict['bots'] }) {
  const d = getPageCopy(locale).developers;
  const mcp = getMcp(locale);
  const docs = (page: string) => localePath(locale, `docs/${page}`);
  const nav = [
    { id: 'bots', label: d.nav.bots },
    { id: 'mcp', label: d.nav.mcp },
    { id: 'sdk', label: d.nav.sdk },
    { id: 'webhooks', label: d.nav.webhooks },
    { id: 'oauth', label: d.nav.oauth },
  ];
  return (
    <>
      <section id="top" aria-labelledby="developers-title" className="section page-hero">
        <Container>
          <SectionHeading id="developers-title" as="h1" title={d.title} lead={d.lead} sticker="lightning" />
          <nav aria-label={d.eyebrow} className="page-nav">
            {nav.map((n) => (
              <a key={n.id} href={`#${n.id}`} className="chip">
                {n.label}
              </a>
            ))}
          </nav>
        </Container>
      </section>

      <Section id="bots" labelledBy="bots-title">
        <SectionHeading id="bots-title" title={bots.title} lead={bots.lead} />
        <ul className="card-grid card-grid-4">
          {CARDS.map((c) => (
            <Card as="li" key={c.id}>
              <c.icon aria-hidden="true" className="card-icon" size={26} strokeWidth={1.75} />
              <h3 className="h3 h3-sm">{bots.cards[c.id].title}</h3>
              <p className="tile-text">{bots.cards[c.id].text}</p>
            </Card>
          ))}
        </ul>
        <p className="caption section-note">{bots.rights}</p>
        <div className="button-row">
          <Button href={docs('bots/')}>{bots.docsLang ? `${bots.docs} ${bots.docsLang}` : bots.docs}</Button>
          <Button href={docs('bots/quickstart/')} variant="secondary">
            {bots.ctaTitle}
          </Button>
        </div>
        <SectionCta locale={locale} className="section-cta-center" />
      </Section>

      <Section id="mcp" labelledBy="mcp-title">
        <SectionHeading id="mcp-title" title={mcp.title} lead={mcp.lead} />
        <div className="split">
          <ul className="card-grid card-grid-2">
            {mcp.points.map((p) => (
              <Card as="li" key={p.title}>
                <h3 className="h3 h3-sm">{p.title}</h3>
                <p className="tile-text">{p.text}</p>
              </Card>
            ))}
          </ul>
          <Card>
            <McpSnippet inline />
            <h3 className="h3 h3-sm mt-6">{mcp.toolsTitle}</h3>
            <ul className="tool-list">
              {mcp.tools.map((tool) => (
                <li key={tool.name}>
                  <code>{tool.name}</code> — {tool.text}
                </li>
              ))}
            </ul>
            <p className="caption mt-4">{mcp.note}</p>
          </Card>
        </div>
        <div className="button-row">
          <Button href={docs('bots/mcp/')} variant="secondary">
            {mcp.docs}
          </Button>
        </div>
        <SectionCta locale={locale} className="section-cta-center" />
      </Section>

      <Section id="sdk" labelledBy="sdk-title">
        <SectionHeading id="sdk-title" title={d.sdkTitle} lead={d.sdkLead} />
        <figure className="code-figure">
          <div className="code-window">
            <pre lang="en">
              <BotCode />
            </pre>
          </div>
          <figcaption className="caption">
            {bots.codeTitle}.{' '}
            {rich(bots.codeCaption, {
              examples: (
                <a href={BOT_EXAMPLES_URL} className="link font-mono">
                  examples/bots
                </a>
              ),
            })}
          </figcaption>
        </figure>
        <div className="button-row">
          <Button href={docs('bots/sdk/')} variant="secondary">
            {d.docs}: SDK
          </Button>
          <Button href={BOT_SDK_URL} variant="secondary">
            {bots.sdk}
          </Button>
        </div>
        <SectionCta locale={locale} className="section-cta-center" />
      </Section>

      <Section id="webhooks" labelledBy="webhooks-title">
        <div className="split">
          <SectionHeading id="webhooks-title" title={d.webhooksTitle} lead={d.webhooksLead} />
          <Card>
            <Points items={d.webhooksPoints} />
            <div className="button-row button-row-start">
              <Button href={docs('bots/webhooks/')} variant="secondary" size="md">
                {d.docs}
              </Button>
            </div>
          </Card>
        </div>
        <SectionCta locale={locale} className="section-cta-center" />
      </Section>

      <Section id="oauth" labelledBy="oauth-title">
        <div className="split">
          <SectionHeading id="oauth-title" title={d.oauthTitle} lead={d.oauthLead} />
          <Card>
            <Points items={d.oauthPoints} />
            <div className="button-row button-row-start">
              <Button href={docs('oauth/')} variant="secondary" size="md">
                {d.docs}
              </Button>
            </div>
          </Card>
        </div>
        <SectionCta locale={locale} className="section-cta-center" />
      </Section>
    </>
  );
}
