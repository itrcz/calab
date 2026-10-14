import { llmsFullTxt, textResponse } from '@/lib/llms';

// Exported as out/llms-full.txt (static route handler): full product text + every English docs page.
export const dynamic = 'force-static';

export async function GET(): Promise<Response> {
  return textResponse(await llmsFullTxt());
}
