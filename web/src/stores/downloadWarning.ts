// SPDX-License-Identifier: Apache-2.0
/**
 * The pending question of the download warning (lib/download.ts): which file, what kind of program, and the answer's
 * resolver. {@link DownloadWarningDialog} shows it; without a mounted dialog the browser's own confirm asks.
 */
import { create } from "zustand";
import type { ExecutableKind } from "@tavrn/sdk";

interface Pending {
  name: string;
  kind: ExecutableKind;
  resolve: (anyway: boolean) => void;
}

interface DownloadWarningState {
  pending: Pending | null;
  /** Mounted dialogs (the app mounts one). */
  dialogs: number;
}

export const useDownloadWarning = create<DownloadWarningState>(() => ({ pending: null, dialogs: 0 }));

/** Asks whether to save the file anyway; a newer question cancels an unanswered one. */
export function askDownloadAnyway(name: string, kind: ExecutableKind, fallback: () => boolean): Promise<boolean> {
  if (useDownloadWarning.getState().dialogs === 0) return Promise.resolve(fallback());
  useDownloadWarning.getState().pending?.resolve(false);
  return new Promise((resolve) => useDownloadWarning.setState({ pending: { name, kind, resolve } }));
}

export function answerDownloadWarning(anyway: boolean): void {
  const pending = useDownloadWarning.getState().pending;
  useDownloadWarning.setState({ pending: null });
  pending?.resolve(anyway);
}
