import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';
import type { SessionActivitySnapshot } from '../../desktop/src/shared/hostActivity';

interface NativeSessionActivity {
  isSupported(): boolean;
  publish(document: string, generation: number, status: string, muted: boolean, language: string): Promise<void>;
  end(): Promise<void>;
}

// No Android JS interface or authority until it has an equivalent proven native frame boundary.
const native = Platform.OS === 'ios' ? requireOptionalNativeModule<NativeSessionActivity>('CalabSessionActivity') : null;
export const sessionActivityEnabled = native?.isSupported() === true;

/** Serialize ActivityKit operations; failure/disabled-by-user is optional, never a web load failure. */
let pending = Promise.resolve();
export function publishSessionActivity(document: string, snapshot: SessionActivitySnapshot): void {
  pending = pending.then(async () => {
    await native?.publish(document, snapshot.generation, snapshot.status, snapshot.muted, snapshot.language);
  }).catch(() => undefined);
}
export function endSessionActivity(): void {
  pending = pending.then(async () => { await native?.end(); }).catch(() => undefined);
}
