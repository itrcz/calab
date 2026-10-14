// Public URLs shown on the landing. These are site content (not runtime config).
export const SITE_URL = 'https://calab.io';
export const APP_URL = 'https://app.calab.io';
// Stable installer names of the newest release (release.yml copies each stable release to latest/;
// latest/VERSION holds its number). Same names as the /download/<os> shortcuts in infra/docker/caddy.
export const LATEST_URL = 'https://releases.calab.io/latest';
export const DOWNLOADS = {
  macArm64: `${LATEST_URL}/Calab-mac-arm64.dmg`,
  macX64: `${LATEST_URL}/Calab-mac-x64.dmg`,
  win: `${LATEST_URL}/Calab-win-x64.exe`,
  appImage: `${LATEST_URL}/Calab-linux-x86_64.AppImage`,
  deb: `${LATEST_URL}/calab-linux-amd64.deb`,
} as const;
// Public intake form for the CALAB board.
export const CONTACT_FORM_URL = 'https://app.calab.ru/f/_y56peSvjI6J4kIqy62NF97shkLcfg71VNu7heERWJo';
export const GPTUNNEL_URL = 'https://gptunnel.ai';
export const REPO_URL = 'https://github.com/itrcz/calab';
export const repoFile = (path: string): string => `${REPO_URL}/blob/main/${path}`;
export const repoTree = (path: string): string => `${REPO_URL}/tree/main/${path}`;
// Bot API (ADR-0031): the public docs live in the repository, in Russian and English.
export const botDocs = (russian: boolean): string => repoFile(russian ? 'docs/19-bot-api.md' : 'docs/19-bot-api.en.md');
export const BOT_EXAMPLES_URL = repoTree('examples/bots');
export const BOT_SDK_URL = repoTree('packages/bot-sdk');
