'use client';

/**
 * Mirrors the native updater's snapshot for the sidebar pill, the update
 * panel, Settings › About and the toasts. It pulls once on mount and then
 * follows `updater-status`; every action goes through a native command, which
 * also decides whether it may run (the install gate refuses while busy).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  checkNow as checkNowCommand,
  downloadNow as downloadNowCommand,
  getStatus,
  installNow as installNowCommand,
  isInstallRefusal,
  onStatus,
  setAutoCheck as setAutoCheckCommand,
  type BusyReason,
  type UpdaterSnapshot,
} from '@/lib/updater';

/** How long a refusal's reasons stay next to Restart and update. */
export const REFUSAL_MS = 10_000;

interface UpdaterContextValue {
  status: UpdaterSnapshot | null;
  /**
   * Reasons the last Restart and update was refused for, until the reported
   * work ends, the next try, or REFUSAL_MS.
   */
  refusedFor: BusyReason[];
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  checkNow: () => Promise<void>;
  download: () => Promise<void>;
  installNow: () => Promise<void>;
  setAutoCheck: (enabled: boolean) => Promise<void>;
}

const UpdaterContext = createContext<UpdaterContextValue | null>(null);

export const useUpdater = () => useContext(UpdaterContext);

export function UpdaterProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<UpdaterSnapshot | null>(null);
  const [refusedFor, setRefusedFor] = useState<BusyReason[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void onStatus((snapshot) => {
      if (!disposed) setStatus(snapshot);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    }).catch(() => undefined);
    // The native side may still be starting; the first push arrives anyway.
    getStatus().then((snapshot) => {
      if (!disposed) setStatus(snapshot);
    }).catch(() => undefined);
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  const run = useCallback(async (action: () => Promise<UpdaterSnapshot>) => {
    try {
      setStatus(await action());
    } catch (error) {
      console.warn('[Updater] command failed:', error);
    }
  }, []);

  const checkNow = useCallback(() => run(checkNowCommand), [run]);
  const download = useCallback(() => run(downloadNowCommand), [run]);
  const setAutoCheck = useCallback((enabled: boolean) => run(() => setAutoCheckCommand(enabled)), [run]);
  const installNow = useCallback(async () => {
    setRefusedFor([]);
    try {
      setStatus(await installNowCommand());
    } catch (error) {
      if (isInstallRefusal(error) && error.kind === 'busy') setRefusedFor(error.reasons);
      else console.warn('[Updater] install was not started:', error);
    }
  }, []);

  const busy = status?.busyReasons.length ?? 0;
  useEffect(() => {
    if (busy === 0) setRefusedFor([]);
  }, [busy]);
  // A refusal can name work that busyReasons never lists (the speech engine
  // lock, a summary that ended before the refresh), so the count above may
  // never change; without the timer the button would stay disabled.
  useEffect(() => {
    if (refusedFor.length === 0) return;
    const timer = setTimeout(() => setRefusedFor([]), REFUSAL_MS);
    return () => clearTimeout(timer);
  }, [refusedFor]);

  const value = useMemo(
    () => ({ status, refusedFor, panelOpen, setPanelOpen, checkNow, download, installNow, setAutoCheck }),
    [status, refusedFor, panelOpen, checkNow, download, installNow, setAutoCheck],
  );
  return <UpdaterContext.Provider value={value}>{children}</UpdaterContext.Provider>;
}
