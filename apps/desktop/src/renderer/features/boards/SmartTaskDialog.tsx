import { TaskPriority } from '@calaba/protocol';
import { Bot, Paperclip, Sparkles } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { Button, Modal, MOD, TextArea, cx } from '../../components/ui';
import { t } from '../../i18n';
import { smartErrorRef, smartErrorText } from '../../lib/ai';
import { ApiError } from '../../lib/api/client';
import { errorText } from '../../lib/api/errors';
import { isUploading, readyIds, roomLeft } from '../../lib/boards/pendingFiles';
import { openBoardLink, openTaskAnywhere } from '../../services/boards';
import { boardsApi } from '../../services/boardsApi';
import { useBoards } from '../../stores/boards';
import { useBoardsUi } from '../../stores/boardsUi';
import { toast } from '../../stores/toasts';
import { PendingFileList, usePendingFiles } from './CreateTaskAttachments';
import { PriorityMenu } from './menus';
import { PRIORITY_LABEL, PriorityIcon } from './visuals';

const MAX_TEXT = 4000;

/**
 * «Создать умную задачу» (CBF-68, ADR-0118; CBF-75, ADR-0123): the text, files (uploaded to the
 * workspace at once; the model sees images, a PDF's first and last page and text files' text)
 * and a priority («авто» lets the board's instruction decide). «Создать» — the server picks the
 * board with the model and creates the task as me; the task then opens for editing. An error or
 * the model's refusal (missing data, a duplicate) keeps the text and the files and says why
 * inline; the person edits and sends again.
 */
export function SmartTaskDialog(): ReactNode {
  const ws = useBoardsUi((s) => s.smartFor);
  if (!ws) return null;
  return <Dialog key={ws} workspaceId={ws} />;
}

function Dialog({ workspaceId }: { workspaceId: string }): ReactNode {
  const close = (): void => useBoardsUi.getState().openSmart(null);
  const [text, setText] = useState('');
  const [priority, setPriority] = useState<TaskPriority>(TaskPriority.NONE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; ref: string } | null>(null);
  const [refusal, setRefusal] = useState<{ reason: string; duplicateKey: string } | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const files = usePendingFiles(boardsApi.workspaceUploadPath(workspaceId));
  const uploading = isUploading(files.items);
  const ready = text.trim().length > 0 && !uploading && !busy;

  const submit = async (): Promise<void> => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    setRefusal(null);
    try {
      const r = await boardsApi.createSmart(workspaceId, { text: text.trim(), priority, attachmentIds: readyIds(files.items) });
      if (r.filesUnseen) toast.info(t('smart.filesUnseen'));
      if (r.refusal) {
        setRefusal({ reason: r.refusal.reason, duplicateKey: r.refusal.duplicateKey });
        return;
      }
      const task = r.task;
      if (!task) return;
      useBoards.getState().upsertTask(task);
      const board = useBoards.getState().boards[task.boardId];
      toast.success(t('smart.created', { key: task.key, board: board?.name ?? '' }));
      if (r.attachmentsDropped) toast.info(t('smart.filesDropped'));
      close();
      openTaskAnywhere(task);
    } catch (e) {
      // Never a bare «Не удалось сохранить» (bug #152): the cause in words, and the code, status
      // and request id to quote — the server logs the request under that id.
      const m = e instanceof ApiError ? smartErrorText({ status: e.status, reason: e.reason, field: e.field, message: e.message }) : null;
      setError({
        text: m ? t(m.key, m.reason ? { reason: t(m.reason) } : undefined) : errorText(e, t('smart.err.notCreated')),
        ref: e instanceof ApiError ? smartErrorRef(e) : e instanceof Error ? e.name : '',
      });
    } finally {
      setBusy(false);
    }
  };

  const chip = 'inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-line px-2.5 text-control text-fg hover:bg-hover data-[state=open]:bg-active';
  return (
    <Modal
      open
      onClose={close}
      medium
      title={t('smart.title')}
      description={t('smart.intro')}
      initialFocus={textRef}
      footer={
        <>
          {busy ? (
            <span className="mr-auto flex min-w-0 items-center gap-1.5 text-control text-muted" role="status">
              <Sparkles className="size-3.5 shrink-0" aria-hidden /> <span className="truncate">{t('smart.busy')}</span>
            </span>
          ) : null}
          <Button variant="secondary" onClick={close} className="mobile:hidden">
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void submit()} busy={busy} disabled={!ready} title={`${MOD}↩`} data-testid="smart-task-submit">
            {t('smart.create')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) e.preventDefault();
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          files.add([...e.dataTransfer.files]);
        }}
        data-testid="smart-task"
      >
        <TextArea
          ref={textRef}
          value={text}
          maxLength={MAX_TEXT}
          rows={6}
          disabled={busy}
          onChange={(e) => {
            setText(e.target.value);
            if (error) setError(null);
            if (refusal) setRefusal(null);
          }}
          onPaste={(e) => {
            const pasted = [...e.clipboardData.files];
            if (!pasted.length) return;
            e.preventDefault();
            files.add(pasted);
          }}
          placeholder={t('smart.placeholder')}
          aria-label={t('smart.text')}
          className="min-h-32"
          data-testid="smart-task-text"
        />
        <PendingFileList items={files.items} onRemove={files.remove} />
        <div className="flex flex-wrap items-center gap-1.5">
          <PriorityMenu value={priority} onPick={setPriority}>
            <button type="button" className={chip} data-testid="smart-task-priority">
              <PriorityIcon priority={priority} /> {priority === TaskPriority.NONE ? t('smart.priorityAuto') : t(PRIORITY_LABEL[priority] ?? 'boards.prio.none')}
            </button>
          </PriorityMenu>
          {roomLeft(files.items) > 0 ? (
            <>
              <button type="button" className={cx(chip, 'text-muted')} onClick={() => fileInput.current?.click()} data-testid="smart-task-attach">
                <Paperclip className="size-3.5" aria-hidden /> {t('smart.attach')}
              </button>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  files.add([...(e.target.files ?? [])]);
                  e.target.value = '';
                }}
              />
            </>
          ) : null}
          {files.items.length ? <span className="text-caption text-faint">{t('smart.filesNote')}</span> : null}
        </div>
        {refusal ? (
          <div className="flex gap-2 rounded-lg border border-line px-3 py-2.5" role="alert" data-testid="smart-task-refusal">
            <Bot className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-control font-medium text-fg">{t('smart.refused')}</span>
              <span className="whitespace-pre-wrap break-words text-control text-muted">{refusal.reason}</span>
              {refusal.duplicateKey ? (
                <button
                  type="button"
                  className="self-start text-control text-accent-text hover:underline"
                  onClick={() => {
                    close();
                    openBoardLink('task', refusal.duplicateKey);
                  }}
                  data-testid="smart-task-duplicate"
                >
                  {t('smart.openDuplicate', { key: refusal.duplicateKey })}
                </button>
              ) : null}
              <span className="text-caption text-faint">{t('smart.refusedHint')}</span>
            </div>
          </div>
        ) : null}
        {error ? (
          <div className="flex flex-col gap-0.5" role="alert" data-testid="smart-task-error">
            <p className="text-caption text-danger-text">{error.text}</p>
            {error.ref ? (
              <p className="select-text break-all text-caption text-muted" data-testid="smart-task-error-ref">
                {t('smart.err.ref', { ref: error.ref })}
              </p>
            ) : null}
          </div>
        ) : null}
      </form>
    </Modal>
  );
}
