'use client';

/**
 * Settings layout pieces: a titled group of rows in one card, and the row
 * itself (what it is on the left, its control on the right). Labs set this
 * look first; sections use these so every page of Settings reads the same.
 */
import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

type GroupProps = {
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLElement>, 'title'>;

export const SettingsGroup = React.forwardRef<HTMLElement, GroupProps>(function SettingsGroup(
  { title, description, children, className, ...props },
  ref,
) {
  const titleId = React.useId();
  return (
    <section ref={ref} aria-labelledby={titleId} className={cn('scroll-mt-6', className)} {...props}>
      <div className="mb-2 px-1">
        <h3 id={titleId} className="text-[11px] font-semibold uppercase tracking-[0.08em] text-af-text-4">
          {title}
        </h3>
        {description && <p className="mt-1 text-[13px] leading-relaxed text-af-text-3">{description}</p>}
      </div>
      <div className="settings-group-card divide-y divide-af-border rounded-2xl border border-af-border bg-af-panel-2/40">{children}</div>
    </section>
  );
});

type RowProps = {
  icon?: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Sits on the right of the title; wraps under it when the row is narrow. */
  control?: React.ReactNode;
  /** Full-width content under the title and control. */
  children?: React.ReactNode;
  /** Makes the title the label of this control. */
  htmlFor?: string;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>;

export const SettingRow = React.forwardRef<HTMLDivElement, RowProps>(function SettingRow(
  { icon: Icon, title, description, control, children, htmlFor, className, ...props },
  ref,
) {
  const Title = htmlFor ? 'label' : 'h4';
  return (
    <div ref={ref} className={cn('scroll-mt-6 px-5 py-4', className)} {...props}>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        {Icon && (
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-af-accent/[0.12] text-af-accent">
            <Icon className="h-[18px] w-[18px]" />
          </span>
        )}
        <div className="min-w-0 flex-1 basis-60">
          <Title htmlFor={htmlFor} className="block text-sm font-semibold text-af-text">
            {title}
          </Title>
          {description && <div className="mt-0.5 text-[13px] leading-relaxed text-af-text-3">{description}</div>}
        </div>
        {control && <div className="flex min-w-0 max-w-full shrink-0 items-center gap-2">{control}</div>}
      </div>
      {children && <div className={cn('mt-3', Icon && 'setting-row-body-indented')}>{children}</div>}
    </div>
  );
});

/** A quiet line under a row: what a choice means, or what just happened. */
export function RowNote({
  tone = 'muted',
  icon: Icon,
  children,
  className,
  ...props
}: {
  tone?: 'muted' | 'success' | 'warning' | 'danger';
  icon?: LucideIcon;
  children: React.ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn(
        'flex items-start gap-1.5 text-xs leading-relaxed [overflow-wrap:anywhere]',
        tone === 'muted' && 'text-af-text-3',
        tone === 'success' && 'text-af-success',
        tone === 'warning' && 'text-af-warning',
        tone === 'danger' && 'text-af-danger',
        className,
      )}
      {...props}
    >
      {Icon && <Icon className="mt-px h-3.5 w-3.5 shrink-0" />}
      <span className="min-w-0">{children}</span>
    </p>
  );
}
