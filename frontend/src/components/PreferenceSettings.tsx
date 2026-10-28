"use client"

import { useEffect, useState } from "react"
import { Switch } from "./ui/switch"
import { Input } from "./ui/input"
import { Bell, Palette, UserRound } from "lucide-react"
import { useConfig, NotificationSettings } from "@/contexts/ConfigContext"
import { ThemePicker } from "@/components/settings/ThemePicker"
import { SettingRow, SettingsGroup } from "@/components/settings/SettingsGroup"

export function PreferenceSettings() {
  // The recordings folder is set in Settings › Recording.
  const {
    notificationSettings,
    storageLocations,
    isLoadingPreferences,
    loadPreferences,
    updateNotificationSettings,
  } = useConfig();

  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean | null>(null);
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const [previousNotificationsEnabled, setPreviousNotificationsEnabled] = useState<boolean | null>(null);

  // "Your name" — used to label the user's mic transcripts as "You (Name)".
  const [userName, setUserName] = useState<string>('');
  useEffect(() => {
    if (typeof window !== 'undefined') {
      setUserName(localStorage.getItem('meetily_user_name') || '');
    }
  }, []);
  const saveUserName = (v: string) => {
    setUserName(v);
    if (typeof window !== 'undefined') {
      localStorage.setItem('meetily_user_name', v);
    }
  };

  // Lazy load preferences on mount (only loads if not already cached)
  useEffect(() => {
    loadPreferences();
  }, [loadPreferences]);

  // Update notificationsEnabled when notificationSettings are loaded from global state
  useEffect(() => {
    if (notificationSettings) {
      // Notification enabled means both started and stopped notifications are enabled
      const enabled =
        notificationSettings.notification_preferences.show_recording_started &&
        notificationSettings.notification_preferences.show_recording_stopped;
      setNotificationsEnabled(enabled);
      if (isInitialLoad) {
        setPreviousNotificationsEnabled(enabled);
        setIsInitialLoad(false);
      }
    } else if (!isLoadingPreferences) {
      // If not loading and no settings, use default
      setNotificationsEnabled(true);
      if (isInitialLoad) {
        setPreviousNotificationsEnabled(true);
        setIsInitialLoad(false);
      }
    }
  }, [notificationSettings, isLoadingPreferences, isInitialLoad])

  useEffect(() => {
    // Skip update on initial load or if value hasn't actually changed
    if (isInitialLoad || notificationsEnabled === null || notificationsEnabled === previousNotificationsEnabled) return;
    if (!notificationSettings) return;

    const handleUpdateNotificationSettings = async () => {
      console.log("Updating notification settings to:", notificationsEnabled);

      try {
        // Update the notification preferences
        const updatedSettings: NotificationSettings = {
          ...notificationSettings,
          notification_preferences: {
            ...notificationSettings.notification_preferences,
            show_recording_started: notificationsEnabled,
            show_recording_stopped: notificationsEnabled,
          }
        };

        console.log("Calling updateNotificationSettings with:", updatedSettings);
        await updateNotificationSettings(updatedSettings);
        setPreviousNotificationsEnabled(notificationsEnabled);
        console.log("Successfully updated notification settings to:", notificationsEnabled);
      } catch (error) {
        console.error('Failed to update notification settings:', error);
      }
    };

    handleUpdateNotificationSettings();
  }, [notificationsEnabled, notificationSettings, isInitialLoad, previousNotificationsEnabled, updateNotificationSettings])

  const loading = (
    <div className="space-y-3">
      <div className="af-skeleton h-40 rounded-2xl" />
      <div className="af-skeleton h-20 rounded-2xl" />
    </div>
  );

  // Show loading only if we're actually loading and don't have cached data
  if (isLoadingPreferences && !notificationSettings && !storageLocations) {
    return loading
  }

  // Show loading if notificationsEnabled hasn't been determined yet
  if (notificationsEnabled === null && !isLoadingPreferences) {
    return loading
  }

  // Ensure we have a boolean value for the Switch component
  const notificationsEnabledValue = notificationsEnabled ?? false;

  return (
    <div className="space-y-8">
      <SettingsGroup title="Appearance">
        <SettingRow icon={Palette} title="Theme" description="Applies to every window, including the floating recording bar.">
          <ThemePicker />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="You">
        <SettingRow
          icon={UserRound}
          title="Your name"
          htmlFor="settings-user-name"
          description={
            <>
              Your microphone is labeled <strong className="font-medium text-af-text-2">You ({userName || 'Name'})</strong> in
              transcripts. Other voices are labeled by speaker until you name them.
            </>
          }
          control={
            <Input
              id="settings-user-name"
              type="text"
              value={userName}
              onChange={(e) => saveUserName(e.target.value)}
              placeholder="e.g. Tyler"
              className="w-56 max-w-full"
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Notifications">
        <SettingRow
          icon={Bell}
          title="Recording started and stopped"
          description="Show a system notification when a recording starts or stops."
          control={
            <Switch
              checked={notificationsEnabledValue}
              onCheckedChange={setNotificationsEnabled}
              aria-label="Notify when a recording starts or stops"
            />
          }
        />
      </SettingsGroup>
    </div>
  )
}
