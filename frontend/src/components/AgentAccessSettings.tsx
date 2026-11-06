'use client';

/**
 * Settings > AI agents (#8): whether AI agents may read the meeting library
 * through Protocol's MCP server, and how to connect Claude Code and Claude
 * Desktop to it. The native side owns the switch file and the server's path
 * (agent_access.rs); the server reads the switch on every call, so turning it
 * off or on needs no restart anywhere.
 */
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Bot, Check, Copy, MessageSquare, SquareTerminal, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { RowNote, SettingRow, SettingsGroup } from '@/components/settings/SettingsGroup';

/** `agent_access::AgentAccess`. */
export interface AgentAccess {
  enabled: boolean;
  databasePath: string;
  command: string;
  args: string[];
  serverFound: boolean;
  translocated: boolean;
  claudeCodeCommand: string;
  claudeDesktopConfig: string;
}

export const AGENT_PRIVACY =
  "An AI agent on this computer, such as Claude Desktop or Claude Code, can read your meetings: transcripts, summaries, notes, action items, people and groups. It can't change anything or play audio. Whatever the agent reads is sent to the agent's model provider (for Claude, Anthropic) under your account.";

function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      toast.error('Could not copy', { description: String(error) });
    }
  };
  return (
    <div className="flex items-start gap-2">
      <pre
        aria-label={label}
        className="min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-xl border border-af-border bg-af-panel px-3 py-2 font-mono text-xs leading-relaxed text-af-text-2"
      >
        {text}
      </pre>
      <Button variant="secondary" size="sm" onClick={copy} aria-label={`Copy ${label}`}>
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

function Connect({ access }: { access: AgentAccess }) {
  if (access.translocated) {
    return (
      <RowNote tone="warning" icon={TriangleAlert}>
        Move Protocol to the Applications folder first. macOS runs it from a temporary copy whose location changes on
        every launch, so an agent could not find it.
      </RowNote>
    );
  }
  if (!access.serverFound) {
    return (
      <RowNote tone="warning" icon={TriangleAlert}>
        This build doesn&apos;t include the server ({access.command} is missing).
      </RowNote>
    );
  }
  return (
    <SettingsGroup title="Connect an agent">
      <SettingRow
        icon={SquareTerminal}
        title="Claude Code"
        description="Run this once in a terminal. Claude Code then offers Protocol's tools in every project."
      >
        <CopyBlock label="Claude Code command" text={access.claudeCodeCommand} />
      </SettingRow>
      <SettingRow
        icon={MessageSquare}
        title="Claude Desktop"
        description="Paste into Claude Desktop > Settings > Developer > Edit Config, then restart Claude Desktop. If the file already lists servers under mcpServers, add the protocol entry next to them."
      >
        <CopyBlock label="Claude Desktop configuration" text={access.claudeDesktopConfig} />
      </SettingRow>
    </SettingsGroup>
  );
}

export function AgentAccessSettings() {
  const [access, setAccess] = useState<AgentAccess | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    invoke<AgentAccess>('get_agent_access')
      .then(setAccess)
      .catch((error) => setLoadError(String(error)));
  }, []);

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      setAccess(await invoke<AgentAccess>('set_agent_access', { enabled }));
    } catch (error) {
      toast.error('Could not change access for AI agents', { description: String(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SettingsGroup title="Access">
        <SettingRow
          icon={Bot}
          htmlFor="agent-access"
          title="Let AI agents read your meetings"
          description={AGENT_PRIVACY}
          control={
            <Switch
              id="agent-access"
              checked={access?.enabled ?? false}
              disabled={!access || busy}
              onCheckedChange={toggle}
            />
          }
        >
          {loadError && <RowNote tone="danger">Could not read this setting: {loadError}</RowNote>}
          {access?.enabled && (
            <RowNote>Turning this off stops agents at their next question; nothing needs restarting.</RowNote>
          )}
        </SettingRow>
      </SettingsGroup>
      {access?.enabled && <Connect access={access} />}
    </>
  );
}
