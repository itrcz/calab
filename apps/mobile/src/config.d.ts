/** See config.js. */
export declare class WebOriginError extends Error {}
export declare function parseWebOrigin(raw: string | undefined): string;
export declare function parseLinkHosts(raw: string | undefined, origin?: string | null): string[];
export declare function parseReleaseIdentity(version?: string, buildNumber?: string): { version: string; buildNumber: string };
