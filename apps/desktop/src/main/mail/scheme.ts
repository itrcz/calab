/** The `calaba-mail://` scheme (ADR-0088 §7), Electron-free so apiProtocol.ts can register it. */
export const MAIL_SCHEME = 'calaba-mail';

/** Added to the one `registerSchemesAsPrivileged` call (apiProtocol.ts): Electron keeps only the last call. */
export const MAIL_SCHEME_PRIVILEGES = { scheme: MAIL_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } } as const;
