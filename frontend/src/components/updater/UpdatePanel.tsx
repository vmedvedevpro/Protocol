'use client';

import { invoke } from '@tauri-apps/api/core';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useUpdater } from '@/contexts/UpdaterContext';
import { busySentence, downloadPercent, errorSentence, releaseUrl, type UpdaterSnapshot } from '@/lib/updater';
import { ReleaseNotes } from './ReleaseNotes';

export const openExternal = (url: string) => {
  invoke('open_external_url', { url }).catch((error) => console.error('Failed to open link:', error));
};

export const RESTART_NOTE =
  'Protocol closes for about half a minute while the update installs, then opens again. Your meetings and settings are kept.';
export const MAC_PERMISSIONS_NOTE =
  'macOS may ask again for microphone and screen recording access after the update.';
export const DOWNLOAD_NOTE =
  'Protocol downloads the update only when you click Download, checks its signature, and installs it when you restart or quit, never during a recording.';
export const MANUAL_NOTE = "Packages installed with apt don't update themselves. Download the new package from GitHub.";

/** The sentence under the title, for an offered release. */
export function offerLine(status: UpdaterSnapshot): string | null {
  const offer = status.offer;
  if (!offer) return null;
  if (offer.manualOnly) return MANUAL_NOTE;
  if (status.activity.state === 'downloading') {
    const percent = downloadPercent(status.activity);
    return percent === null ? 'Downloading…' : `Downloading… ${percent}%`;
  }
  if (offer.waitingForRecording) return 'The download starts after the recording.';
  if (offer.downloaded) return RESTART_NOTE;
  return DOWNLOAD_NOTE;
}

/** Why Restart and update is unavailable right now, if it is. */
export function blockedLine(status: UpdaterSnapshot, refusedFor: string[]): string | null {
  if (!status.offer?.downloaded) return null;
  const reason = (refusedFor[0] ?? status.busyReasons[0]) as UpdaterSnapshot['busyReasons'][number] | undefined;
  return reason ? busySentence(reason) : null;
}

/** The popover behind the sidebar pill and the toasts' Details. */
export function UpdatePanel({ onClose }: { onClose: () => void }) {
  const updater = useUpdater();
  const status = updater?.status;
  const offer = status?.offer;
  if (!updater || !status || !offer) return null;

  const { version, notes } = offer.release;
  const downloading = status.activity.state === 'downloading';
  const installing = status.activity.state === 'installing';
  const percent = downloadPercent(status.activity);
  const blocked = blockedLine(status, updater.refusedFor);
  const error = status.error && !status.error.background && status.error.action !== 'check' ? status.error : null;

  return (
    <div className="space-y-3" aria-live="polite">
      <div>
        <h3 className="text-sm font-semibold text-af-text">
          {offer.downloaded ? `Protocol ${version} is ready` : `Protocol ${version} is available`}
        </h3>
        <p className="mt-1 text-[13px] leading-relaxed text-af-text-3">{offerLine(status)}</p>
        {status.platform === 'macos' && !offer.manualOnly && (
          <p className="mt-1 text-[12px] leading-relaxed text-af-text-3">{MAC_PERMISSIONS_NOTE}</p>
        )}
      </div>
      {downloading && <Progress value={percent ?? 0} aria-label="Download progress" />}
      {notes && <ReleaseNotes notes={notes} />}
      <button type="button" className="text-[12px] text-af-accent hover:underline" onClick={() => openExternal(releaseUrl(version))}>
        Release notes on GitHub
      </button>
      {error && (
        <p role="alert" className="text-[12px] leading-relaxed text-af-danger">
          {errorSentence(error, status.platform, version, status.currentVersion)}
        </p>
      )}
      {blocked && <p className="text-[12px] leading-relaxed text-af-warning">{blocked}</p>}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Later
        </Button>
        {offer.manualOnly ? (
          <Button size="sm" onClick={() => openExternal(releaseUrl(version))}>
            Download from GitHub
          </Button>
        ) : offer.downloaded ? (
          <Button size="sm" disabled={!!blocked || installing} onClick={() => void updater.installNow()}>
            {installing ? 'Restarting…' : 'Restart and update'}
          </Button>
        ) : (
          <Button size="sm" disabled={downloading || offer.waitingForRecording} onClick={() => void updater.download()}>
            {error ? 'Try again' : 'Download'}
          </Button>
        )}
      </div>
    </div>
  );
}
