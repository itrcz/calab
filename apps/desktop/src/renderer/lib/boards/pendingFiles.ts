/** Files attached while a task is being created (they upload at once; the task takes their ids). */
export const MAX_TASK_FILES = 20;

export interface PendingFile {
  key: string;
  name: string;
  /** Uploaded file id; '' while uploading. */
  id: string;
  /** 0..1 */
  progress: number;
  failed: boolean;
}

/** Ids of finished uploads, in order — what `CreateTaskRequest.attachment_ids` carries. */
export function readyIds(items: readonly PendingFile[]): string[] {
  return items.filter((f) => f.id).map((f) => f.id);
}

export function isUploading(items: readonly PendingFile[]): boolean {
  return items.some((f) => !f.id && !f.failed);
}

/** How many more files fit under the cap (failed ones do not count). */
export function roomLeft(items: readonly PendingFile[]): number {
  return Math.max(0, MAX_TASK_FILES - items.filter((f) => !f.failed).length);
}
