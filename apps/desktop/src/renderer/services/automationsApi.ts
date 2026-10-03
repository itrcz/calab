import type { MessageInitShape } from '@bufbuild/protobuf';
import {
  BoardGitResponseSchema,
  BoardRuleResponseSchema,
  CreateBoardRuleRequestSchema,
  ListBoardRulesResponseSchema,
  ListRuleRunsResponseSchema,
  RuleTestResponseSchema,
  SetBoardGitRequestSchema,
  TestBoardRuleRequestSchema,
  UpdateBoardRuleRequestSchema,
  type GitProvider,
} from '@calaba/protocol';
import { body, call, callEmpty, qs } from '../lib/api/client';

/**
 * Board automations REST (ADR-0060 §3–§4, proto/calaba/v1/automations.proto): rules (read —
 * VIEW_BOARD; write, dry run and the run log — MANAGE_BOARD) and the board's Git webhook
 * (MANAGE_BOARD + MANAGE_INTEGRATIONS). Bodies are protojson through the generated schemas.
 */
export const automationsApi = {
  rules: {
    list: (boardId: string, signal?: AbortSignal) => call('GET', `/api/boards/${boardId}/rules`, ListBoardRulesResponseSchema, undefined, signal),
    /** 409 CONFLICT: RULE_LIMIT (20), FEATURE_DISABLED (field trigger), PLAN_LIMIT; 422 with the field. */
    create: (boardId: string, init: MessageInitShape<typeof CreateBoardRuleRequestSchema>) =>
      call('POST', `/api/boards/${boardId}/rules`, BoardRuleResponseSchema, body(CreateBoardRuleRequestSchema, init)),
    update: (ruleId: string, init: MessageInitShape<typeof UpdateBoardRuleRequestSchema>) =>
      call('PATCH', `/api/rules/${ruleId}`, BoardRuleResponseSchema, body(UpdateBoardRuleRequestSchema, init)),
    remove: (ruleId: string) => callEmpty('DELETE', `/api/rules/${ruleId}`),
    /** A dry run on a task of the board: nothing changes. */
    test: (ruleId: string, taskId: string) => call('POST', `/api/rules/${ruleId}/test`, RuleTestResponseSchema, body(TestBoardRuleRequestSchema, { taskId })),
    runs: (ruleId: string, limit = 50, signal?: AbortSignal) => call('GET', `/api/rules/${ruleId}/runs${qs({ limit })}`, ListRuleRunsResponseSchema, undefined, signal),
  },
  git: {
    /** `git` unset when the board has none. */
    get: (boardId: string, signal?: AbortSignal) => call('GET', `/api/boards/${boardId}/git`, BoardGitResponseSchema, undefined, signal),
    /** Creates or replaces; `secret` '' = the server generates one (returned once). */
    set: (boardId: string, provider: GitProvider, secret: string) => call('PUT', `/api/boards/${boardId}/git`, BoardGitResponseSchema, body(SetBoardGitRequestSchema, { provider, secret })),
    remove: (boardId: string) => callEmpty('DELETE', `/api/boards/${boardId}/git`),
  },
};
