import type { Locale } from '@/i18n';
import { getHome } from '@/i18n/home';
import { nb, Section, SectionHeading, Tile } from './ui';
import { SectionCta } from './section-cta';

/** The three-line MCP snippet of the third AI tile (§4.6): address and header, nothing else (docs: bots/mcp). */
export function McpSnippet({ inline }: { inline?: boolean | undefined }) {
  return (
    <pre className={inline ? 'code-snippet code-snippet-inline' : 'code-snippet'} lang="en">
      <code>
        <span className="code-comment"># Streamable HTTP</span>
        {'\n'}
        <span className="code-key">url</span>: https://app.calab.io/api/mcp{'\n'}
        <span className="code-key">Authorization</span>: Bearer calab_bot_…
      </code>
    </pre>
  );
}

/** «AI там, где он экономит время» (§4.6): smart task, transcripts, any LLM via MCP. */
export function AiSection({ locale }: { locale: Locale }) {
  const t = getHome(locale);
  const a = t.ai;
  return (
    <Section id="ai" labelledBy="ai-title" className="ai">
      <SectionHeading id="ai-title" title={a.title} accent={a.accent} lead={a.lead} sticker="lightning" />
      <ul className="tile-row swipe-sm">
        {a.tiles.map((tile) => (
          <Tile
            key={tile.title}
            scene={tile.shot ?? undefined}
            media={tile.shot ? undefined : <McpSnippet inline />}
            locale={locale}
            title={tile.title}
            text={tile.text}
            alt={tile.shot ? t.alts[tile.shot] : ''}
            sizes="(min-width: 1360px) 680px, (min-width: 1024px) 50vw, 86vw"
          />
        ))}
      </ul>
      <p className="caption section-note">{nb(a.plan)}</p>
      <SectionCta locale={locale} />
    </Section>
  );
}
