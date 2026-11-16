import { create } from '@bufbuild/protobuf';
import {
  BoardFormFieldTarget as Target,
  BoardFormFieldType as Kind,
  BoardFormRouteSchema,
  TaskPriority,
  type BoardFormDefinition,
  type BoardFormField,
  type BoardFormRoute,
} from '@calaba/protocol';
import { Plus, Trash2 } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button, Field, Input, Select, Switch } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { useBoards, workspaceBoards } from '../../stores/boards';
import { useWorkspaces } from '../../stores/workspaces';
import { asEnum } from '../../lib/enums';

/** Forms v2 settings of the editor (ADR-0064 «v2»): per-field limits, roles and task mapping, routes. */

const PRIORITIES: [TaskPriority, MessageKey][] = [
  [TaskPriority.NONE, 'boards.prio.none'],
  [TaskPriority.LOW, 'boards.prio.low'],
  [TaskPriority.MEDIUM, 'boards.prio.medium'],
  [TaskPriority.HIGH, 'boards.prio.high'],
  [TaskPriority.URGENT, 'boards.prio.urgent'],
];

const CATEGORIES: [string, MessageKey][] = [
  ['image', 'forms.accept.image'],
  ['pdf', 'forms.accept.pdf'],
  ['document', 'forms.accept.document'],
  ['video', 'forms.accept.video'],
  ['audio', 'forms.accept.audio'],
  ['archive', 'forms.accept.archive'],
];

const TITLE = 'title';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The task fields a field type can fill. */
function targetsOf(type: Kind): [Target | typeof TITLE, MessageKey][] {
  const out: [Target | typeof TITLE, MessageKey][] = [[Target.UNSPECIFIED, 'forms.map.none']];
  if (type !== Kind.CHECKBOX && type !== Kind.MULTISELECT && type !== Kind.FILE && type !== Kind.PEOPLE) out.push([TITLE, 'forms.map.title']);
  if (type === Kind.SELECT) out.push([Target.PRIORITY, 'forms.map.priority']);
  if (type === Kind.DATE) out.push([Target.DUE_DATE, 'forms.map.due']);
  if (type === Kind.SELECT || type === Kind.MULTISELECT) out.push([Target.LABELS, 'forms.map.labels']);
  if (type === Kind.PEOPLE)
    out.push([Target.ASSIGNEES, 'forms.map.assignees'], [Target.APPROVERS, 'forms.map.approvers'], [Target.WATCHERS, 'forms.map.watchers']);
  return out;
}

/** Resets what a field type change leaves meaningless. */
export function retype(f: BoardFormField, type: Kind): Partial<BoardFormField> {
  const keep = targetsOf(type).some(([x]) => x === f.target);
  return {
    type,
    options: type === Kind.SELECT || type === Kind.MULTISELECT ? f.options : [],
    multiple: type === Kind.FILE || type === Kind.PEOPLE ? f.multiple : false,
    maxFiles: type === Kind.FILE ? f.maxFiles : 0,
    maxFileMb: type === Kind.FILE ? f.maxFileMb : 0,
    accept: type === Kind.FILE ? f.accept : [],
    roleId: type === Kind.PEOPLE ? f.roleId : '',
    target: keep ? f.target : Target.UNSPECIFIED,
    optionPriorities: keep && type === Kind.SELECT ? f.optionPriorities : {},
    optionLabels: keep ? f.optionLabels : {},
  };
}

/** Option maps keep only options the field still has. */
export function pruneOptions(f: BoardFormField, options: string[]): Partial<BoardFormField> {
  const keep = <V,>(m: Record<string, V>): Record<string, V> => Object.fromEntries(Object.entries(m).filter(([k]) => options.includes(k)));
  return { options, optionPriorities: keep(f.optionPriorities), optionLabels: keep(f.optionLabels) };
}

export const FieldV2 = memo(function FieldV2({
  f,
  boardId,
  workspaceId,
  isTitle,
  usedTargets,
  onField,
  onTitle,
}: {
  f: BoardFormField;
  boardId: string;
  workspaceId: string;
  isTitle: boolean;
  /** Targets other fields hold (one field per task field, labels excepted). */
  usedTargets: readonly Target[];
  onField: (id: string, patch: Partial<BoardFormField>) => void;
  onTitle: (id: string, on: boolean) => void;
}): ReactNode {
  const labels = useBoards((s) => s.boards[boardId]?.labels);
  const roles = useWorkspaces((s) => s.byId[workspaceId]?.roles);
  const value = isTitle ? TITLE : String(f.target);
  const options = f.options.filter((o) => o.trim());
  return (
    <>
      {f.type === Kind.FILE ? (
        <>
          <Switch checked={f.multiple} onChange={(v) => onField(f.id, { multiple: v, maxFiles: v ? f.maxFiles : 0 })} label={t('forms.multiple')} />
          <div className="grid grid-cols-2 gap-3">
            {f.multiple ? (
              <Field label={t('forms.maxFiles')}>
                <Input type="number" min={1} max={20} value={f.maxFiles || 5} onChange={(e) => onField(f.id, { maxFiles: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })} />
              </Field>
            ) : null}
            <Field label={t('forms.maxFileMb')}>
              <Input type="number" min={1} max={100} value={f.maxFileMb || 100} onChange={(e) => onField(f.id, { maxFileMb: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })} />
            </Field>
          </div>
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-caption font-medium text-muted">{t('forms.accept')}</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {CATEGORIES.map(([c, label]) => (
                <label key={c} className="flex min-h-8 items-center gap-2 text-body">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--color-accent)]"
                    checked={f.accept.includes(c)}
                    onChange={(e) => onField(f.id, { accept: e.target.checked ? [...f.accept, c] : f.accept.filter((x) => x !== c) })}
                  />
                  {t(label)}
                </label>
              ))}
            </div>
          </fieldset>
        </>
      ) : null}
      {f.type === Kind.PEOPLE ? (
        <>
          <Switch checked={f.multiple} onChange={(v) => onField(f.id, { multiple: v })} label={t('forms.multiple')} />
          <Field label={t('forms.role')}>
            <Select value={f.roleId} onChange={(e) => onField(f.id, { roleId: e.target.value })}>
              <option value="">{t('forms.anyRole')}</option>
              {roles
                ?.filter((r) => UUID.test(r.id))
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
            </Select>
          </Field>
        </>
      ) : null}
      <Field label={t('forms.mapTo')}>
        <Select
          value={value}
          onChange={(e) => {
            const v = e.target.value;
            if (v === TITLE) {
              onField(f.id, { target: Target.UNSPECIFIED, optionPriorities: {}, optionLabels: {} });
              onTitle(f.id, true);
              return;
            }
            const target = asEnum(Target, Number(v));
            onField(f.id, {
              target,
              optionPriorities: target === Target.PRIORITY ? f.optionPriorities : {},
              optionLabels: target === Target.LABELS ? f.optionLabels : {},
            });
            if (isTitle) onTitle(f.id, false);
          }}
        >
          {targetsOf(f.type).map(([x, label]) => (
            <option key={x} value={String(x)} disabled={x !== TITLE && x !== Target.UNSPECIFIED && x !== Target.LABELS && x !== f.target && usedTargets.includes(x)}>
              {t(label)}
            </option>
          ))}
        </Select>
      </Field>
      {f.target === Target.PRIORITY || f.target === Target.LABELS ? (
        <div className="flex flex-col gap-2 rounded-[var(--radius-control)] bg-hover p-2">
          {options.map((o) => (
            <div key={o} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-body">{o}</span>
              <span aria-hidden className="text-muted">
                →
              </span>
              {f.target === Target.PRIORITY ? (
                <Select
                  aria-label={o}
                  className="w-44"
                  value={f.optionPriorities[o] ?? TaskPriority.NONE}
                  onChange={(e) => {
                    const p = asEnum(TaskPriority, Number(e.target.value));
                    const next = { ...f.optionPriorities };
                    if (p === TaskPriority.NONE) delete next[o];
                    else next[o] = p;
                    onField(f.id, { optionPriorities: next });
                  }}
                >
                  {PRIORITIES.map(([p, label]) => (
                    <option key={p} value={p}>
                      {t(label)}
                    </option>
                  ))}
                </Select>
              ) : (
                <Select
                  aria-label={o}
                  className="w-44"
                  value={f.optionLabels[o] ?? ''}
                  onChange={(e) => {
                    const next = { ...f.optionLabels };
                    if (e.target.value) next[o] = e.target.value;
                    else delete next[o];
                    onField(f.id, { optionLabels: next });
                  }}
                >
                  <option value="">{t('forms.noLabel')}</option>
                  {labels?.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
});

/** Routes by answer: «if field = option → board, status»; none matching: this board. */
export function RoutesEditor({
  draft,
  boardId,
  workspaceId,
  onChange,
}: {
  draft: BoardFormDefinition;
  boardId: string;
  workspaceId: string;
  onChange: (patch: Partial<BoardFormDefinition>) => void;
}): ReactNode {
  const boards = useBoards(useShallow((s) => workspaceBoards(s.boards, workspaceId)));
  const selects = draft.fields.filter((f) => f.type === Kind.SELECT && f.options.some((o) => o.trim()));
  const set = (i: number, patch: Partial<BoardFormRoute>): void =>
    onChange({ routes: draft.routes.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-body font-medium">{t('forms.routes')}</h3>
        <p className="text-caption text-muted">{t('forms.routesHint')}</p>
      </div>
      {draft.routes.map((r, i) => {
        const field = selects.find((f) => f.id === r.fieldId);
        const target = boards.find((b) => b.id === r.boardId);
        return (
          <div key={i} className="grid grid-cols-1 gap-2 rounded-[var(--radius-card)] border border-line p-3 sm:grid-cols-2">
            <Field label={t('forms.routeIf')}>
              <Select value={r.fieldId} onChange={(e) => set(i, { fieldId: e.target.value, option: '' })}>
                <option value="">—</option>
                {selects.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('forms.routeEquals')}>
              <Select value={r.option} onChange={(e) => set(i, { option: e.target.value })}>
                <option value="">—</option>
                {field?.options
                  .filter((o) => o.trim())
                  .map((o) => (
                    <option key={o}>{o}</option>
                  ))}
              </Select>
            </Field>
            <Field label={t('forms.routeBoard')}>
              <Select value={r.boardId} onChange={(e) => set(i, { boardId: e.target.value, statusId: '' })}>
                <option value="">—</option>
                {boards.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.emoji ? `${b.emoji} ` : ''}
                    {b.name}
                    {b.id === boardId ? ` · ${t('forms.thisBoard')}` : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('forms.routeStatus')}>
              <Select value={r.statusId} onChange={(e) => set(i, { statusId: e.target.value })}>
                <option value="">{t('forms.defaultStatus')}</option>
                {target?.statuses.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Button
              variant="secondary"
              className="justify-self-start"
              aria-label={t('forms.removeRoute')}
              onClick={() => onChange({ routes: draft.routes.filter((_, j) => j !== i) })}
            >
              <Trash2 className="size-4" />
              {t('forms.removeRoute')}
            </Button>
          </div>
        );
      })}
      <Button
        variant="secondary"
        className="self-start"
        disabled={selects.length === 0 || draft.routes.length >= 20}
        onClick={() => onChange({ routes: [...draft.routes, create(BoardFormRouteSchema, { fieldId: selects[0]?.id ?? '' })] })}
      >
        <Plus className="size-4" />
        {t('forms.addRoute')}
      </Button>
    </section>
  );
}
