/**
 * The in-app updater as the frontend sees it. Native code
 * (frontend/src-tauri/src/updater/) owns every check, download and install and
 * pushes one snapshot as `updater-status`; this module mirrors its types, wraps
 * the commands, and keeps the wording for its reasons and errors in one place.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export const RELEASES_URL = 'https://github.com/vmedvedevpro/Protocol/releases';
export const PRIVACY_URL = 'https://github.com/vmedvedevpro/Protocol/blob/main/PRIVACY_POLICY.md';
export const STATUS_EVENT = 'updater-status';

export type BusyReason =
  | 'recording'
  | 'recordingStopping'
  | 'recordingSave'
  | 'import'
  | 'retranscription'
  | 'diarization'
  | 'summary'
  | 'postCall'
  | 'modelDownload'
  | 'onboarding'
  | 'speechEngine';

export type UiActivity = 'recordingSave' | 'postCall';

export type ErrorKind =
  | 'network'
  | 'noRelease'
  | 'noPlatform'
  | 'feed'
  | 'signature'
  | 'download'
  | 'diskSpace'
  | 'installStart'
  | 'installIncomplete'
  | 'location';

export interface Release {
  version: string;
  notes: string | null;
  date: string | null;
}

export interface Offer {
  release: Release;
  downloaded: boolean;
  manualOnly: boolean;
  waitingForRecording: boolean;
}

export interface UpdateError {
  kind: ErrorKind;
  action: 'check' | 'download' | 'install';
  message: string;
  at: number;
  background: boolean;
}

export type Activity =
  | { state: 'idle' }
  | { state: 'checking'; manual: boolean }
  | { state: 'downloading'; received: number; total: number | null }
  | { state: 'installing' };

export type Support =
  | { kind: 'updatable'; install: string }
  | { kind: 'manualOnly'; install: string }
  | { kind: 'off'; reason: 'dev' | 'notInstalled' };

export interface UpdaterSnapshot {
  currentVersion: string;
  platform: 'windows' | 'macos' | 'linux';
  support: Support;
  autoCheck: boolean;
  lastCheckedAt: number | null;
  activity: Activity;
  offer: Offer | null;
  error: UpdateError | null;
  busyReasons: BusyReason[];
  updatedFrom: string | null;
}

export type InstallRefusal =
  | { kind: 'notReady' }
  | { kind: 'busy'; reasons: BusyReason[] }
  | { kind: 'failed' };

export const getStatus = () => invoke<UpdaterSnapshot>('updater_get_status');
export const checkNow = () => invoke<UpdaterSnapshot>('updater_check_now');
export const downloadNow = () => invoke<UpdaterSnapshot>('updater_download_now');
export const installNow = () => invoke<UpdaterSnapshot>('updater_install_now');
export const setAutoCheck = (enabled: boolean) => invoke<UpdaterSnapshot>('updater_set_auto_check', { enabled });
export const reportUiActivity = (activities: UiActivity[]) => invoke<void>('updater_set_ui_activity', { activities });

export function onStatus(handler: (snapshot: UpdaterSnapshot) => void): Promise<UnlistenFn> {
  return listen<UpdaterSnapshot>(STATUS_EVENT, (event) => handler(event.payload));
}

export const isInstallRefusal = (value: unknown): value is InstallRefusal =>
  typeof value === 'object' && value !== null && 'kind' in value;

/** The end of "Protocol can't restart while …". */
const BUSY_SENTENCES: Record<BusyReason, string> = {
  recording: 'a recording is in progress',
  recordingStopping: 'a recording is being saved',
  recordingSave: 'a recording is being saved',
  import: 'an audio import is running',
  retranscription: 'a meeting is being retranscribed',
  diarization: 'speakers are being identified',
  summary: 'a summary is being generated',
  postCall: 'a meeting is being processed',
  modelDownload: 'a model is downloading',
  onboarding: "setup isn't finished",
  speechEngine: 'the speech engine is busy',
};

export const busySentence = (reason: BusyReason) => `Protocol can't restart while ${BUSY_SENTENCES[reason]}.`;

export function errorSentence(error: UpdateError, platform: UpdaterSnapshot['platform'], version?: string, current?: string): string {
  switch (error.kind) {
    case 'network':
      return "Couldn't reach GitHub. Check your connection and try again.";
    case 'noRelease':
      return 'No published release found.';
    case 'noPlatform':
      return `A newer version isn't available for ${platformName(platform)} yet.`;
    case 'feed':
      return "The update information on GitHub couldn't be read.";
    case 'signature':
      return 'The downloaded update failed its signature check and was deleted. Nothing was installed.';
    case 'download':
      return `The download stopped: ${error.message}.`;
    case 'diskSpace':
      return 'Not enough free disk space for the update.';
    case 'installStart':
      return `The installer couldn't start (${error.message}). Protocol is still running.`;
    case 'installIncomplete':
      return `The update${version ? ` to ${version}` : ''} didn't finish. Protocol is still on ${current ?? 'the previous version'}.`;
    case 'location':
      return platform === 'macos'
        ? 'Move Protocol to the Applications folder and try again.'
        : "Protocol can't replace the AppImage because its folder is read-only. Download the new AppImage from GitHub.";
  }
}

export function platformName(platform: UpdaterSnapshot['platform']): string {
  return platform === 'macos' ? 'macOS' : platform === 'windows' ? 'Windows' : 'Linux';
}

export const releaseUrl = (version: string) => `${RELEASES_URL}/tag/v${version}`;

/** "2 hours ago", "just now", "yesterday". */
export function relativeTime(at: number, now = Date.now()): string {
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export function downloadPercent(activity: Activity): number | null {
  if (activity.state !== 'downloading' || !activity.total) return null;
  return Math.min(100, Math.round((activity.received / activity.total) * 100));
}

/**
 * Work only the frontend can see, reported to native code as a lease (see
 * src-tauri/src/updater/busy.rs). Components mark their activity here;
 * UpdaterActivityReporter sends the whole set.
 */
type ActivityListener = (activities: UiActivity[]) => void;
const activeUi = new Set<UiActivity>();
const activityListeners = new Set<ActivityListener>();

export function markUiActivity(activity: UiActivity, active: boolean) {
  const had = activeUi.has(activity);
  if (active === had) return;
  if (active) activeUi.add(activity);
  else activeUi.delete(activity);
  const current = [...activeUi];
  activityListeners.forEach((listener) => listener(current));
}

export function currentUiActivity(): UiActivity[] {
  return [...activeUi];
}

export function onUiActivity(listener: ActivityListener): () => void {
  activityListeners.add(listener);
  return () => activityListeners.delete(listener);
}
