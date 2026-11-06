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
  extensionSupported: boolean;
  extensionMoved: boolean;
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

/** `claude_desktop_extension::AddedExtension`. */
interface AddedExtension {
  bundle: string;
  opened: boolean;
  openError: string | null;
}

const BY_HAND = 'Paste into Claude Desktop > Settings > Developer > Edit Config, then restart Claude Desktop. If the file already lists servers under mcpServers, add the protocol entry next to them.';

function ClaudeDesktop({ access, onAdded }: { access: AgentAccess; onAdded: () => void }) {
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<AddedExtension | null>(null);
  const config = <CopyBlock label="Claude Desktop configuration" text={access.claudeDesktopConfig} />;

  if (!access.extensionSupported) {
    return (
      <SettingRow icon={MessageSquare} title="Claude Desktop" description={BY_HAND}>
        {config}
      </SettingRow>
    );
  }

  const add = async () => {
    setAdding(true);
    try {
      setAdded(await invoke<AddedExtension>('add_to_claude_desktop'));
      onAdded();
    } catch (error) {
      toast.error('Could not add Protocol to Claude Desktop', { description: String(error) });
    } finally {
      setAdding(false);
    }
  };

  return (
    <SettingRow
      icon={MessageSquare}
      title="Claude Desktop"
      description="Opens Claude Desktop to install Protocol as an extension."
      control={
        <Button variant="secondary" size="sm" onClick={add} disabled={adding}>
          Add to Claude Desktop
        </Button>
      }
    >
      <div className="space-y-2">
        {access.extensionMoved && !added && (
          <RowNote tone="warning" icon={TriangleAlert}>
            Protocol moved since you added it. Add it again.
          </RowNote>
        )}
        {added?.opened && <RowNote tone="success">Finish in Claude Desktop. If nothing opened, set it up by hand below.</RowNote>}
        {added && !added.opened && (
          <RowNote tone="warning" icon={TriangleAlert}>
            {added.openError} Set it up by hand below.
          </RowNote>
        )}
        {added && (
          <RowNote>
            The extension file is {added.bundle}. Claude Desktop also installs it from Settings &gt; Extensions &gt;
            Advanced settings &gt; Install Extension.
          </RowNote>
        )}
        <details className="group">
          <summary className="cursor-pointer text-xs font-medium text-af-text-2">Set up by hand</summary>
          <div className="mt-2 space-y-2">
            <RowNote>{BY_HAND}</RowNote>
            {config}
          </div>
        </details>
      </div>
    </SettingRow>
  );
}

function Connect({ access, onAdded }: { access: AgentAccess; onAdded: () => void }) {
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
      <ClaudeDesktop access={access} onAdded={onAdded} />
    </SettingsGroup>
  );
}

export function AgentAccessSettings() {
  const [access, setAccess] = useState<AgentAccess | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = () =>
    invoke<AgentAccess>('get_agent_access')
      .then(setAccess)
      .catch((error) => setLoadError(String(error)));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      {access?.enabled && <Connect access={access} onAdded={load} />}
    </>
  );
}
