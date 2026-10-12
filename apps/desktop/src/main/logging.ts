import { release } from 'node:os';
import { join } from 'node:path';
import { app, crashReporter } from 'electron';
import log from 'electron-log/main';
import { goneDetails } from './crashRecovery';

/** File logs + crash dumps under userData/logs (for bug reports). */
export function initLogging(): void {
  const dir = join(app.getPath('userData'), 'logs');
  log.transports.file.resolvePathFn = () => join(dir, 'main.log');
  log.transports.file.maxSize = 5 * 1024 * 1024;
  log.transports.console.level = app.isPackaged ? 'warn' : 'info';
  // Main's uncaught exceptions / unhandled rejections: logged with their stack, the process goes on.
  log.errorHandler.startCatching({ showDialog: false });
  app.setPath('crashDumps', join(dir, 'crashes'));
  crashReporter.start({ uploadToServer: false });
  log.info(`Calab ${app.getVersion()} starting (${process.platform} ${process.arch} ${release()}, Electron ${process.versions.electron})`);
  // Every renderer / GPU / utility (mail engine) process that dies: reason and exit code (on
  // Windows an NTSTATUS such as 0xC0000005) — the first thing to read in a crash report.
  app.on('render-process-gone', (_e, wc, details) => {
    let url = '';
    try {
      url = wc.getURL().split(/[?#]/)[0]?.slice(0, 200) ?? '';
    } catch {
      // destroyed already
    }
    log.error('renderer gone', { ...goneDetails(details), url });
  });
  app.on('child-process-gone', (_e, details) => log.error('child process gone', goneDetails(details)));
}

export { log };
