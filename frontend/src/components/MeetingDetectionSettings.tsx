"use client"

import { useEffect, useState } from "react"
import { Switch } from "./ui/switch"
import { Badge } from "./ui/badge"
import { Input } from "./ui/input"
import { invoke } from "@tauri-apps/api/core"
import { Radar, Workflow } from "lucide-react"
import { SettingRow, SettingsGroup } from "@/components/settings/SettingsGroup"
import { toast } from "sonner"
import { useLabs } from "@/hooks/useLabs"
import { setLabsFeature } from "@/lib/labs-features"

interface MeetingDetectionSettings {
  enabled: boolean;
  interval_secs: number;
  meeting_apps: string[];
  ignored_apps: string[];
  notify: boolean;
}

/**
 * Meeting Detection settings panel. Watches running processes for meeting apps
 * (Zoom / Teams / Slack / Webex / Discord / …) and prompts to start recording.
 * Fully on-device. Persisted install-locally via Rust.
 */
export function MeetingDetectionSettings() {
  const [md, setMd] = useState<MeetingDetectionSettings | null>(null);
  const [ignoredInput, setIgnoredInput] = useState('');
  const { labs } = useLabs();
  const [automationBusy, setAutomationBusy] = useState(false);

  useEffect(() => {
    invoke<MeetingDetectionSettings>('get_meeting_detection_settings')
      .then((s) => {
        setMd(s);
        setIgnoredInput((s.ignored_apps || []).join(', '));
      })
      .catch((e) => console.error('Failed to load meeting detection settings:', e));
  }, []);

  const saveMd = async (next: MeetingDetectionSettings) => {
    setMd(next);
    try {
      await invoke('set_meeting_detection_settings', { settings: next });
      // Automation acts on detection's events; without detection it is off too.
      if (!next.enabled && labs.meetingAutomation) await setLabsFeature('meetingAutomation', false);
    } catch (e) {
      console.error('Failed to save meeting detection settings:', e);
    }
  };

  // Labs: turning automation on also turns detection on.
  const setAutomation = async (value: boolean) => {
    setAutomationBusy(true);
    try {
      await setLabsFeature('meetingAutomation', value);
      if (value && md && !md.enabled) setMd({ ...md, enabled: true });
    } catch (error) {
      toast.error('Could not change meeting automation', { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setAutomationBusy(false);
    }
  };

  if (!md) {
    return <div className="af-skeleton h-28 rounded-2xl" />;
  }

  return (
    <SettingsGroup title="Calls">
      <SettingRow
        icon={Radar}
        title="Offer to record when a call starts"
        description="Watches for meeting apps (Zoom, Teams, Slack, Webex, Discord…) and offers to start recording when one starts. Runs on this computer only; nothing is sent anywhere."
        control={<Switch checked={md.enabled} onCheckedChange={(v) => saveMd({ ...md, enabled: v })} aria-label="Offer to record when a call starts" />}
      >
        {md.enabled && (
          <div className="space-y-4 rounded-xl border border-af-border bg-af-panel p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <label htmlFor="meeting-detection-interval" className="text-[13px] text-af-text-2">Check for calls every</label>
              <div className="flex items-center gap-2">
                <Input
                  id="meeting-detection-interval"
                  type="number"
                  min={3}
                  max={3600}
                  value={md.interval_secs}
                  onChange={(e) => setMd({ ...md, interval_secs: Number(e.target.value) || 15 })}
                  onBlur={() => saveMd({ ...md, interval_secs: Math.min(3600, Math.max(3, md.interval_secs || 15)) })}
                  className="h-8 w-20 tabular-nums"
                />
                <span className="text-[13px] text-af-text-3">seconds</span>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3">
              <label htmlFor="meeting-detection-notify" className="text-[13px] text-af-text-2">Also show a system notification</label>
              <Switch id="meeting-detection-notify" checked={md.notify} onCheckedChange={(v) => saveMd({ ...md, notify: v })} />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="meeting-detection-ignored" className="block text-[13px] text-af-text-2">
                Ignore these apps, separated by commas
              </label>
              <Input
                id="meeting-detection-ignored"
                type="text"
                value={ignoredInput}
                onChange={(e) => setIgnoredInput(e.target.value)}
                onBlur={() =>
                  saveMd({
                    ...md,
                    ignored_apps: ignoredInput
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
                placeholder="e.g. obs64, teamviewer"
              />
              <p className="text-xs leading-relaxed text-af-text-4">Watched apps: {md.meeting_apps.join(', ')}</p>
            </div>
          </div>
        )}
      </SettingRow>

      <SettingRow
        icon={Workflow}
        title={
          <span className="inline-flex items-center gap-2">
            Start and stop recordings automatically
            <Badge variant="accent" size="xs">Labs</Badge>
          </span>
        }
        description="Instead of offering, record a detected call once it uses your microphone or camera, and stop and save when it ends. Recordings you start yourself are never stopped. Turning this on also turns on the option above."
        control={
          <Switch
            checked={labs.meetingAutomation}
            disabled={automationBusy}
            onCheckedChange={(value) => void setAutomation(value)}
            aria-label="Start and stop recordings automatically"
          />
        }
      />
    </SettingsGroup>
  );
}
