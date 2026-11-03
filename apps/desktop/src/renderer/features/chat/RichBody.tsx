/**
 * A message or comment text that holds a pipe table (board #148), drawn with the task
 * description's read view (boards/DescriptionView: the same converter and table DOM, a wide table
 * scrolls sideways inside the bubble). Text without a table keeps the chat's Markdown.
 */
import type { ReactNode } from 'react';
import { DescriptionView } from '../boards/DescriptionView';

/** Pictures of the text are the message's attachments; a `calaba-file:` line shows its name. */
const image = (_id: string, alt: string): ReactNode => <span className="text-caption text-faint">{alt}</span>;

export function RichBody({ workspaceId, text }: { workspaceId: string; text: string }): ReactNode {
  return <DescriptionView workspaceId={workspaceId} description={text} image={image} />;
}
