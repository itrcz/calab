/** Only this server's signed, read-only calendar feed may invoke the OS calendar handler. */
export function isCalendarLink(raw: string, origin: string): boolean {
  if (!/^webcal:\/\//i.test(raw)) return false;
  try {
    const url = new URL(raw.replace(/^webcal:/i, 'https:'));
    const server = new URL(origin);
    return (
      server.protocol === 'https:' &&
      url.origin === server.origin &&
      !url.username &&
      !url.password &&
      !url.hash &&
      url.pathname === '/api/calendar-feed.ics' &&
      [...url.searchParams.keys()].length === 1 &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('t') ?? '')
    );
  } catch {
    return false;
  }
}
