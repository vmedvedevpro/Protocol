'use client';

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useUpdater } from '@/contexts/UpdaterContext';
import { openExternal, releaseUrl } from '@/lib/updater';

/** Versions a toast was already shown for, across restarts. */
export const SEEN_KEY = 'protocol-updater-seen-v1';

type ToastKind = 'available' | 'ready' | 'updated';

function readSeen(): Record<string, true> {
  try {
    const value = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

/** Marks the toast as shown; false when it already was. */
export function claimToast(kind: ToastKind, version: string): boolean {
  const key = `${kind}:${version}`;
  const seen = readSeen();
  if (seen[key]) return false;
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify({ ...seen, [key]: true }));
  } catch {
    // Storage unavailable: the toast may repeat after a restart.
  }
  return true;
}

/**
 * One toast per version when a release becomes available, one when its
 * download is ready (only for a download finished in this session), and one
 * after an update installed. Toasts wait while a recording runs.
 */
export function UpdateToasts() {
  const updater = useUpdater();
  const status = updater?.status;
  const openPanel = updater?.setPanelOpen;
  // Downloads restored at launch are announced by the pill, not a toast.
  const downloadedAtMount = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!status || !openPanel) return;
    if (downloadedAtMount.current === undefined) {
      downloadedAtMount.current = status.offer?.downloaded ? status.offer.release.version : null;
    }
    if (status.updatedFrom && claimToast('updated', status.currentVersion)) {
      const version = status.currentVersion;
      toast.success(`Updated to Protocol ${version}`, {
        id: `updater-updated-${version}`,
        duration: 10000,
        action: { label: "What's new", onClick: () => openExternal(releaseUrl(version)) },
      });
    }
    const offer = status.offer;
    if (!offer) return;
    if (status.busyReasons.includes('recording')) return;
    const { version } = offer.release;
    if (offer.downloaded) {
      if (downloadedAtMount.current !== version && claimToast('ready', version)) {
        toast(`Protocol ${version} is ready to install`, {
          id: `updater-ready-${version}`,
          description: 'Restart when it suits you, or it installs when you quit.',
          duration: 10000,
          action: { label: 'Details', onClick: () => openPanel(true) },
        });
      }
    } else if (claimToast('available', version)) {
      toast(`Protocol ${version} is available`, {
        id: `updater-available-${version}`,
        description: offer.manualOnly ? 'Download the new package from GitHub.' : 'Download it when it suits you.',
        duration: 10000,
        action: { label: 'Details', onClick: () => openPanel(true) },
      });
    }
  }, [status, openPanel]);

  return null;
}
