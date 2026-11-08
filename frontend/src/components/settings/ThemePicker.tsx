'use client';

import { RadioGroup } from 'radix-ui';
import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { THEME_PREFERENCES, useAppTheme, type ThemePreference } from '@/lib/app-theme';

const ICONS: Record<ThemePreference, LucideIcon> = { light: Sun, dark: Moon, system: Monitor };

/** Light, Dark or Match system, drawn like the app's segmented tabs. */
export function ThemePicker() {
  const { preference, setPreference } = useAppTheme();

  return (
    <RadioGroup.Root
      aria-label="Theme"
      value={preference}
      onValueChange={(value) => setPreference(value as ThemePreference)}
      className="inline-flex h-9 items-center gap-0.5 rounded-lg border border-af-border bg-af-panel-2 p-[3px] text-af-text-3"
    >
      {THEME_PREFERENCES.map((option) => {
        const Icon = ICONS[option.id];
        return (
          <RadioGroup.Item
            key={option.id}
            value={option.id}
            className={cn(
              'inline-flex h-full items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 text-[13px] font-medium',
              'transition-[background-color,color,box-shadow] duration-150 hover:text-af-text',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-af-accent/60',
              'data-[state=checked]:bg-af-raised data-[state=checked]:text-af-text data-[state=checked]:shadow-sm',
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {option.label}
          </RadioGroup.Item>
        );
      })}
    </RadioGroup.Root>
  );
}
