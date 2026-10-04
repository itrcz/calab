import { clone, create } from '@bufbuild/protobuf';
import {
  BoardFormDefinitionSchema,
  BoardFormFieldSchema,
  BoardFormFieldType as Kind,
  TaskPriority,
  type BoardForm,
  type BoardFormDefinition,
  type BoardFormField,
} from '@calaba/protocol';
import { ArrowDown, ArrowUp, Copy, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { confirmAction } from '../../components/Confirm';
import { Button, Field, Input, Modal, Select, Switch, Spinner } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { boardForms } from '../../services/boardForms';
import { copyText } from '../../services/boards';
import { useBoards } from '../../stores/boards';
import { memberName, useWorkspaces } from '../../stores/workspaces';
import { FormFields, formControl, formError } from './FormFields';

const TYPES: [Kind, MessageKey][] = [
  [Kind.TEXT, 'forms.text'],
  [Kind.PARAGRAPH, 'forms.paragraph'],
  [Kind.EMAIL, 'forms.email'],
  [Kind.NUMBER, 'forms.number'],
  [Kind.DATE, 'forms.date'],
  [Kind.SELECT, 'forms.select'],
  [Kind.CHECKBOX, 'forms.checkbox'],
];

export function BoardForms({ boardId, workspaceId, onClose }: { boardId: string; workspaceId: string; onClose: () => void }): ReactNode {
  const [forms, setForms] = useState<BoardForm[]>();
  const [editing, setEditing] = useState<BoardForm | 'new'>();
  const [error, setError] = useState('');
  const disabled = useWorkspaces((s) => s.byId[workspaceId]?.ws.plan?.limits?.boardFormsDisabled ?? false);
  const limit = useWorkspaces((s) => s.byId[workspaceId]?.ws.plan?.limits?.boardFormsPerBoard ?? 0);
  useEffect(() => {
    let live = true;
    void boardForms
      .list(boardId)
      .then((v) => {
        if (live) setForms(v.forms);
      })
      .catch((e: unknown) => {
        if (live) setError(formError(e));
      });
    return () => {
      live = false;
    };
  }, [boardId]);
  if (editing)
    return (
      <FormEditor
        boardId={boardId}
        workspaceId={workspaceId}
        existing={editing === 'new' ? undefined : editing}
        onClose={() => setEditing(undefined)}
        onSaved={(f) => {
          setForms((old) => [...(old ?? []).filter((x) => x.id !== f.id), f]);
          setEditing(undefined);
        }}
      />
    );
  return (
    <Modal
      open
      onClose={onClose}
      title={t('forms.title')}
      footer={
        <Button disabled={disabled || !forms || (!!limit && forms.length >= limit)} onClick={() => setEditing('new')}>
          <Plus className="size-4" />
          {t('forms.new')}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {disabled ? (
          <p className="text-body text-muted">{t('forms.locked')}</p>
        ) : (
          <p className="text-caption text-muted">
            {forms?.length ?? 0} / {limit || '∞'}
          </p>
        )}
        {error ? (
          <p role="alert" className="text-danger-text">
            {error}
          </p>
        ) : null}
        {!forms && !error ? <Spinner /> : null}
        {forms?.length === 0 ? <p className="py-6 text-center text-muted">{t('forms.empty')}</p> : null}
        {forms?.map((f) => (
          <div key={f.id} className="flex flex-wrap items-center gap-2 rounded-[var(--radius-card)] border border-line p-3">
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-body font-medium">{f.definition?.title}</h3>
              <p className="text-caption text-muted">{t(f.definition?.isPrivate ? 'forms.private' : 'forms.public')}</p>
            </div>
            <Button variant="secondary" aria-label={t('forms.copy')} onClick={() => copyText(f.url, t('forms.copied'))}>
              <Copy className="size-4" />
            </Button>
            <Button variant="secondary" disabled={disabled} onClick={() => setEditing(f)}>
              {t('forms.edit')}
            </Button>
            <Button
              variant="secondary"
              aria-label={t('forms.delete')}
              onClick={() => {
                void (async () => {
                  if (!(await confirmAction(t('forms.delete'), t('forms.deleteHint'), t('forms.delete')))) return;
                  try {
                    await boardForms.remove(boardId, f.id);
                    setForms((old) => old?.filter((x) => x.id !== f.id));
                  } catch (e) {
                    setError(formError(e));
                  }
                })();
              }}
            >
              <Trash2 className="size-4 text-danger-text" />
            </Button>
          </div>
        ))}
      </div>
    </Modal>
  );
}

function FormEditor({
  boardId,
  workspaceId,
  existing,
  onSaved,
  onClose,
}: {
  boardId: string;
  workspaceId: string;
  existing: BoardForm | undefined;
  onSaved: (f: BoardForm) => void;
  onClose: () => void;
}): ReactNode {
  const statuses = useBoards((s) => s.boards[boardId]?.statuses);
  const members = useWorkspaces((s) => s.byId[workspaceId]?.members);
  const [draft, setDraft] = useState<BoardFormDefinition>(() => {
    if (existing?.definition) return clone(BoardFormDefinitionSchema, existing.definition);
    const id = crypto.randomUUID();
    return create(BoardFormDefinitionSchema, {
      title: t('forms.new'),
      statusId: statuses?.find((s) => s.isDefault)?.id ?? statuses?.[0]?.id ?? '',
      titleFieldId: id,
      fields: [{ id, type: Kind.TEXT, label: t('forms.taskTitle'), required: true }],
    });
  });
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(false);
  const [search, setSearch] = useState('');
  const change = (patch: Partial<BoardFormDefinition>): void => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };
  const field = (id: string, patch: Partial<BoardFormField>): void =>
    change({
      fields: draft.fields.map((f) => (f.id === id ? { ...f, ...patch } : f)),
    });
  const move = (index: number, delta: number): void => {
    const fs = [...draft.fields];
    const other = fs[index + delta];
    const current = fs[index];
    if (!other || !current) return;
    fs[index] = other;
    fs[index + delta] = current;
    change({ fields: fs });
  };
  const close = (): void => {
    void (async () => {
      if (!dirty || (await confirmAction(t('forms.discard'), t('forms.discardHint'), t('common.close')))) onClose();
    })();
  };
  const save = (): void => {
    if (busy) return;
    setBusy(true);
    setError('');
    void (existing ? boardForms.update(boardId, existing.id, draft, existing.revision) : boardForms.create(boardId, draft))
      .then((r) => {
        if (r.form) {
          setDirty(false);
          onSaved(r.form);
        }
      })
      .catch((e: unknown) => setError(formError(e)))
      .finally(() => setBusy(false));
  };
  if (preview)
    return (
      <Modal open onClose={() => setPreview(false)} title={draft.title}>
        <FormFields fields={draft.fields} preview submit={(answers) => boardForms.preview(boardId, draft, answers)} />
      </Modal>
    );
  return (
    <Modal
      wide
      open
      onClose={close}
      title={t('forms.title')}
      footer={
        <div className="flex items-center justify-end gap-2 pt-4">
          <Button variant="secondary" onClick={() => setPreview(true)}>
            {t('forms.preview')}
          </Button>
          <Button busy={busy} onClick={save}>
            {t('common.save')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <Field label={t('forms.name')}>
          <Input value={draft.title} maxLength={100} onChange={(e) => change({ title: e.target.value })} />
        </Field>
        <Field label={t('forms.description')}>
          <textarea
            className={`${formControl} !rounded-[var(--radius-card)]`}
            rows={3}
            maxLength={2000}
            value={draft.description}
            onChange={(e) => change({ description: e.target.value })}
          />
        </Field>
        {draft.fields.map((f, i) => (
          <section key={f.id} className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-line p-3">
            <div className="flex items-center gap-2">
              <span className="flex-1 text-caption text-muted">
                {i + 1}
                {f.id === draft.titleFieldId ? ` · ${t('forms.taskTitle')}` : ''}
              </span>
              <Button variant="secondary" disabled={i === 0} aria-label={t('forms.up')} onClick={() => move(i, -1)}>
                <ArrowUp className="size-4" />
              </Button>
              <Button variant="secondary" disabled={i === draft.fields.length - 1} aria-label={t('forms.down')} onClick={() => move(i, 1)}>
                <ArrowDown className="size-4" />
              </Button>
              <Button
                variant="secondary"
                disabled={f.id === draft.titleFieldId}
                aria-label={t('forms.removeField')}
                onClick={() => change({ fields: draft.fields.filter((x) => x.id !== f.id) })}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
            {f.id === draft.titleFieldId ? (
              <div className="flex flex-col gap-1">
                <span className="text-caption font-medium text-muted">{t('forms.type')}</span>
                <span className="text-body text-fg">{t('forms.text')}</span>
                <span className="text-caption text-faint">{t('forms.titleTypeHint')}</span>
              </div>
            ) : (
              <Field label={t('forms.type')}>
                <Select
                  aria-label={t('forms.type')}
                  value={f.type}
                  onChange={(e) => field(f.id, { type: Number(e.target.value), options: [] })}
                >
                  {TYPES.map(([kind, label]) => (
                    <option key={kind} value={kind}>
                      {t(label)}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label={t('forms.label')}>
              <Input value={f.label} maxLength={100} onChange={(e) => field(f.id, { label: e.target.value })} />
            </Field>
            <Field label={t('forms.hint')}>
              <Input value={f.hint} maxLength={500} onChange={(e) => field(f.id, { hint: e.target.value })} />
            </Field>
            <Field label={t('forms.placeholder')}>
              <Input value={f.placeholder} maxLength={500} onChange={(e) => field(f.id, { placeholder: e.target.value })} />
            </Field>
            {f.type === Kind.SELECT ? (
              <Field label={t('forms.options')}>
                <textarea
                  className={`${formControl} !rounded-[var(--radius-card)]`}
                  rows={3}
                  value={f.options.join('\n')}
                  onChange={(e) => field(f.id, { options: e.target.value.split('\n') })}
                />
              </Field>
            ) : null}
            {f.id !== draft.titleFieldId ? (
              <Switch checked={f.required} onChange={(v) => field(f.id, { required: v })} label={t('forms.required')} />
            ) : null}
          </section>
        ))}
        <Button
          variant="secondary"
          disabled={draft.fields.length >= 30}
          onClick={() =>
            change({
              fields: [
                ...draft.fields,
                create(BoardFormFieldSchema, {
                  id: crypto.randomUUID(),
                  type: Kind.TEXT,
                  label: t('forms.label'),
                }),
              ],
            })
          }
        >
          <Plus className="size-4" />
          {t('forms.addField')}
        </Button>
        <Field label={t('forms.status')}>
          <Select
            aria-label={t('forms.status')}
            value={draft.statusId}
            onChange={(e) => change({ statusId: e.target.value })}
          >
            <option value="">—</option>
            {statuses?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('forms.priority')}>
          <Select
            aria-label={t('forms.priority')}
            value={draft.priority}
            onChange={(e) => change({ priority: Number(e.target.value) })}
          >
            {[TaskPriority.NONE, TaskPriority.LOW, TaskPriority.MEDIUM, TaskPriority.HIGH, TaskPriority.URGENT].map((p) => (
              <option key={p} value={p}>
                {t((['boards.prio.none', 'boards.prio.low', 'boards.prio.medium', 'boards.prio.high', 'boards.prio.urgent'] as const)[p])}
              </option>
            ))}
          </Select>
        </Field>
        <Switch
          checked={draft.isPrivate}
          onChange={(v) =>
            change({
              isPrivate: v,
              allowedUserIds: v ? draft.allowedUserIds : [],
            })
          }
          label={t('forms.private')}
          hint={t('forms.privateHint')}
        />
        {draft.isPrivate ? (
          <>
            <Input
              aria-label={t('forms.users')}
              placeholder={t('forms.users')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="max-h-48 overflow-y-auto">
              {Object.values(members ?? {})
                .filter((m) =>
                  memberName(workspaceId, m.user?.id ?? '')
                    .toLocaleLowerCase()
                    .includes(search.toLocaleLowerCase()),
                )
                .map((m) => {
                  const id = m.user?.id;
                  if (!id) return null;
                  return (
                    <label key={id} className="flex min-h-8 items-center gap-2 text-body">
                      <input
                        type="checkbox"
                        checked={draft.allowedUserIds.includes(id)}
                        onChange={(e) =>
                          change({
                            allowedUserIds: e.target.checked ? [...draft.allowedUserIds, id] : draft.allowedUserIds.filter((u) => u !== id),
                          })
                        }
                      />
                      {memberName(workspaceId, m.user?.id ?? '')}
                    </label>
                  );
                })}
            </div>
          </>
        ) : null}
        {error ? (
          <p role="alert" className="text-body text-danger-text">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
