import { llmsTxt, textResponse } from '@/lib/llms';

// Exported as out/llms.txt (static route handler): product text + the docs page list.
export const dynamic = 'force-static';

export async function GET(): Promise<Response> {
  return textResponse(await llmsTxt());
}
