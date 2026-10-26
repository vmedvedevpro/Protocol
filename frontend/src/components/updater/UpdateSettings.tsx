'use client';

import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { useUpdater } from '@/contexts/UpdaterContext';
import {
  downloadPercent,
  errorSentence,
  openExternal,
  PRIVACY_URL,
  relativeTime,
  RELEASES_URL,
  releaseUrl,
  type UpdaterSnapshot,
} from '@/lib/updater';
import { ReleaseNotes } from './ReleaseNotes';
import { blockedLine, MAC_PERMISSIONS_NOTE, MANUAL_NOTE, RESTART_NOTE } from './UpdatePanel';

export const AUTO_CHECK_DESCRIPTION =
  'Once a day Protocol asks GitHub whether a newer release exists. If one does, it shows Update available; ' +
  'Protocol downloads the update only when you click Download, and installs it when you restart or quit, never during a recording.';

/** The status line of Settings › About, per state. */
export function statusLine(status: UpdaterSnapshot, now = Date.now()): string {
  const { support, offer, activity, error } = status;
  if (support.kind === 'off') {
    return support.reason === 'dev'
      ? 'Updates are off in development builds.'
      : 'Updates are off in this copy: it was not installed by the Protocol installer.';
  }
  if (activity.state === 'checking') return 'Checking for updates…';
  if (activity.state === 'installing') return 'Starting the update…';
  if (offer) {
    const { version } = offer.release;
    if (offer.manualOnly) return `Protocol ${version} is available. ${MANUAL_NOTE}`;
    if (activity.state === 'downloading') {
      const percent = downloadPercent(activity);
      return `Downloading Protocol ${version}…${percent === null ? '' : ` ${percent}%`}`;
    }
    if (offer.waitingForRecording) return `Protocol ${version} is available. The download starts after the recording.`;
    if (offer.downloaded) return `Protocol ${version} is ready to install.`;
    return `Protocol ${version} is available.`;
  }
  if (error && !error.background && error.action === 'check') return errorSentence(error, status.platform);
  if (status.lastCheckedAt) return `Protocol is up to date. Last checked ${relativeTime(status.lastCheckedAt, now)}.`;
  return 'Not checked yet.';
}

/** Settings › About: version, status, actions and the automatic-check switch. */
export function UpdateSettings() {
  const updater = useUpdater();
  const status = updater?.status;
  if (!updater || !status) return null;

  const { offer, activity, error, support } = status;
  const busyActivity = activity.state !== 'idle';
  const actionError = error && !error.background && error.action !== 'check' ? error : null;
  // Without an offer the status line carries a failed manual check; with one
  // (the tray's Check for Updates lands here) the alert below must say it.
  const checkError = offer && error && !error.background && error.action === 'check' ? error : null;
  const backgroundError = error?.background ? error : null;
  const blocked = blockedLine(status, updater.refusedFor);
  const percent = downloadPercent(activity);

  let actions: React.ReactNode;
  if (support.kind === 'off') {
    actions = (
      <Button variant="secondary" size="sm" onClick={() => openExternal(RELEASES_URL)}>
        Open releases page
      </Button>
    );
  } else if (offer?.manualOnly) {
    actions = (
      <Button size="sm" onClick={() => openExternal(releaseUrl(offer.release.version))}>
        Download from GitHub
      </Button>
    );
  } else if (offer?.downloaded) {
    actions = (
      <Button size="sm" disabled={!!blocked || busyActivity} onClick={() => void updater.installNow()}>
        Restart and update
      </Button>
    );
  } else if (offer) {
    actions = (
      <>
        <Button size="sm" disabled={busyActivity || offer.waitingForRecording} onClick={() => void updater.download()}>
          {actionError ? 'Try again' : 'Download'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => openExternal(releaseUrl(offer.release.version))}>
          Release notes
        </Button>
      </>
    );
  } else {
    actions = (
      <>
        <Button variant="secondary" size="sm" disabled={busyActivity} onClick={() => void updater.checkNow()}>
          <RefreshCw className="h-3.5 w-3.5" />
          {error && !error.background && error.action === 'check' ? 'Try again' : 'Check for updates'}
        </Button>
        {error && !error.background && error.action === 'check' && (
          <Button variant="ghost" size="sm" onClick={() => openExternal(RELEASES_URL)}>
            Open releases page
          </Button>
        )}
      </>
    );
  }

  return (
    <section aria-labelledby="updates-heading" className="rounded-2xl border border-af-border bg-af-panel-2/40 p-5 space-y-4">
      <div>
        <h4 id="updates-heading" className="text-sm font-semibold text-af-text">Updates</h4>
        <p className="mt-1 text-sm text-af-text-2">Protocol {status.currentVersion}</p>
        <p className="mt-1 flex items-center gap-2 text-[13px] text-af-text-3" role="status">
          {activity.state === 'checking' && <Spinner size={13} />}
          <span>{statusLine(status)}</span>
        </p>
        {backgroundError && !offer && (
          <p className="mt-1 text-[12px] text-af-text-4">
            Last check failed {relativeTime(backgroundError.at)}: {errorSentence(backgroundError, status.platform)}
          </p>
        )}
      </div>

      {activity.state === 'downloading' && <Progress value={percent ?? 0} aria-label="Download progress" />}

      {offer && !offer.manualOnly && (
        <div className="space-y-2">
          {offer.downloaded && <p className="text-[13px] leading-relaxed text-af-text-3">{RESTART_NOTE}</p>}
          {status.platform === 'macos' && <p className="text-[12px] leading-relaxed text-af-text-3">{MAC_PERMISSIONS_NOTE}</p>}
          {offer.release.notes && <ReleaseNotes notes={offer.release.notes} />}
        </div>
      )}

      {actionError && (
        <p role="alert" className="text-[13px] leading-relaxed text-af-danger">
          {errorSentence(actionError, status.platform, offer?.release.version, status.currentVersion)}
        </p>
      )}
      {checkError && (
        <p role="alert" className="text-[13px] leading-relaxed text-af-danger">
          {errorSentence(checkError, status.platform)}
        </p>
      )}
      {blocked && <p className="text-[13px] leading-relaxed text-af-warning">{blocked}</p>}

      <div className="flex flex-wrap items-center gap-2">{actions}</div>

      {support.kind !== 'off' && (
        <div className="flex items-start gap-4 border-t border-af-border pt-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-af-text" id="auto-check-label">Check for updates automatically</p>
            <p className="mt-0.5 text-[13px] leading-relaxed text-af-text-3">
              {AUTO_CHECK_DESCRIPTION}{' '}
              <button type="button" className="text-af-accent hover:underline" onClick={() => openExternal(PRIVACY_URL)}>
                Privacy policy
              </button>
            </p>
          </div>
          <Switch
            className="mt-1"
            checked={status.autoCheck}
            onCheckedChange={(checked) => void updater.setAutoCheck(checked)}
            aria-labelledby="auto-check-label"
          />
        </div>
      )}
    </section>
  );
}
