import { create } from 'zustand';
import type { WebAppSignInAsk } from '../../shared/ipc';

/** The «Sign in with Calab» consent main asks about (ADR-0159); null while there is none. */
export const useSignInAsk = create<{ ask: WebAppSignInAsk | null }>()(() => ({ ask: null }));
