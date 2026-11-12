import { timestampDate } from '@bufbuild/protobuf/wkt';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useSettingsNav } from '../../components/SettingsWindow';
import { CopyField } from '../../components/CopyField';
import { Button, Card, IconButton, Row, Spinner } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { errorText } from '../../lib/api/errors';
import { fmt } from '../../lib/format';
import { shareOrigin } from '../../services/links';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { mcpClientSnippets, mcpServerUrl, mcpSessionClient } from '../mcp/model';

/**
 * Settings → MCP (CBF-183, ADR-0158): connect an AI agent to Calab as yourself — the server
 * address of this server, what to run in each client, and the connected clients (the person's
 * MCP sessions, revoked like any session; «Сеансы» lists them too).
 */
export function McpTab(): ReactNode {
  const serverUrl = useSession((s) => s.serverUrl);
  const origin = shareOrigin(serverUrl);
  const url = origin ? mcpServerUrl(origin) : '';
  const snippets = mcpClientSnippets(url);
  return (
    <>
      <p className="px-1 text-body text-muted">{t('mcpSettings.intro')}</p>
      <Card title={t('mcpSettings.url')} footer={t('mcpSettings.urlHint')}>
        <div className="px-3 py-2.5">
          <CopyField value={url} label={t('mcpSettings.url')} testId="mcp-url" />
        </div>
      </Card>
      <Card title={t('mcpSettings.clients')}>
        <Client name={t('mcpSettings.claudeCode')} hint={t('mcpSettings.claudeCodeHint')} snippet={snippets.claudeCode} testId="mcp-claude-code" />
        <Client name={t('mcpSettings.claudeAi')} hint={t('mcpSettings.claudeAiHint')} />
        <Client name={t('mcpSettings.codex')} hint={t('mcpSettings.codexHint')} snippet={snippets.codex} testId="mcp-codex" />
        <Client name={t('mcpSettings.cursor')} hint={t('mcpSettings.cursorHint')} snippet={snippets.cursor} testId="mcp-cursor" />
      </Card>
      <Connections />
    </>
  );
}

function Client({ name, hint, snippet, testId }: { name: string; hint: string; snippet?: string; testId?: string }): ReactNode {
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2.5" data-settings-row>
      <div className="flex flex-col">
        <span className="text-body" data-settings-label data-settings-hint={hint}>
          {name}
        </span>
        <span className="text-caption text-faint">{hint}</span>
      </div>
      {snippet ? <CopyField value={snippet} label={name} {...(testId ? { testId } : {})} /> : null}
    </div>
  );
}

/** The person's MCP connections: their MCP sessions (the same list as «Сеансы»). */
function Connections(): ReactNode {
  const qc = useQueryClient();
  const nav = useSettingsNav();
  const q = useQuery({ queryKey: ['sessions'], queryFn: () => api.me.sessions() });
  const revoke = useMutation({
    mutationFn: (id: string) => api.me.revokeSession(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['sessions'] }),
    onError: (e) => toast.fail(e, t('err.ctx.save')),
  });
  const list = (q.data?.sessions ?? []).flatMap((s) => {
    const client = mcpSessionClient(s.deviceName);
    return client === null ? [] : [{ s, client }];
  });
  return (
    <Card title={t('mcpSettings.connections')} footer={t('mcpSettings.connectionsHint')}>
      {q.isLoading ? (
        <div className="px-3 py-2.5">
          <Spinner />
        </div>
      ) : null}
      {q.error ? <p className="px-3 py-2.5 text-body text-danger-text">{errorText(q.error, t('err.ctx.load'))}</p> : null}
      {q.data && list.length === 0 ? <Row label={t('mcpSettings.none')} /> : null}
      {list.map(({ s, client }) => (
        <Row key={s.id} label={client} hint={`${t('sessions.lastSeen')} ${s.lastSeenAt ? fmt.stamp(timestampDate(s.lastSeenAt)) : '—'}`}>
          <IconButton label={t('mcpSettings.revoke')} className="text-muted hover:text-danger" disabled={revoke.isPending && revoke.variables === s.id} onClick={() => revoke.mutate(s.id)}>
            <Trash2 className="size-4" />
          </IconButton>
        </Row>
      ))}
      {nav ? (
        <Row label={t('mcpSettings.allSessions')}>
          <Button variant="ghost" size="sm" onClick={() => nav('sessions')}>
            {t('settings.sessions')}
            <ChevronRight className="size-3.5" aria-hidden />
          </Button>
        </Row>
      ) : null}
    </Card>
  );
}
