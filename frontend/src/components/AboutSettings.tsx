"use client"

import { useEffect, useState } from "react"
import Image from "next/image"
import { invoke } from "@tauri-apps/api/core"
import { Github, Shield, Cpu, Heart } from "lucide-react"
import { UpdateSettings } from "@/components/updater/UpdateSettings"

/**
 * About panel for Protocol. Shows version, a short description, the updates
 * block (status, manual check, the automatic-check switch), and links to the
 * source and privacy policy.
 */
export function AboutSettings() {
  const [version, setVersion] = useState('0.0.1');

  useEffect(() => {
    (async () => {
      try {
        const { getVersion } = await import('@tauri-apps/api/app');
        setVersion(await getVersion());
      } catch {
        // Not in a Tauri context; keep the default.
      }
    })();
  }, []);

  const openUrl = (url: string) => {
    invoke('open_external_url', { url }).catch((e) => console.error('Failed to open URL:', e));
  };

  const REPO_URL = 'https://github.com/vmedvedevpro/Protocol';
  const ORIGINAL_MEETILY_URL = 'https://github.com/Zackriya-Solutions/meetily';
  const ACTUALLY_FREE_URL = 'https://github.com/TylerBuza/Meetily-ActuallyFree';

  return (
    <div className="space-y-6">
      {/* Identity card */}
      <div className="rounded-2xl border border-af-border bg-af-panel-2/40 p-5">
        <div className="flex items-center gap-4">
          <Image src="/logo-collapsed.png" alt="Protocol" width={56} height={56} className="h-14 w-14 shrink-0 rounded-2xl shadow-sm" />
          <div>
            <h3 className="text-lg font-semibold text-af-text">Protocol</h3>
            <p className="text-sm text-af-text-2">
              Version {version} · Local-first meeting recorder and transcriber
            </p>
          </div>
        </div>
        <p className="mt-4 text-sm text-af-text-2 leading-relaxed">
          Records, transcribes and summarizes your meetings on your own machine, with GPU
          acceleration and speaker labels. Cloud models are used only when you configure them
          with your own key. No account, no telemetry. Protocol checks GitHub for new releases
          once a day and downloads one only when you click Download; you can turn the check off
          below.
        </p>
      </div>

      {/* Highlights */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-2xl border border-af-border bg-af-panel-2/40 p-4">
          <Cpu className="w-5 h-5 text-af-accent mb-2" />
          <div className="text-sm font-medium text-af-text">On-device</div>
          <div className="text-xs text-af-text-3">Local transcription &amp; summaries</div>
        </div>
        <div className="rounded-2xl border border-af-border bg-af-panel-2/40 p-4">
          <Shield className="w-5 h-5 text-af-success mb-2" />
          <div className="text-sm font-medium text-af-text">Private</div>
          <div className="text-xs text-af-text-3">No telemetry; your meetings stay on your PC</div>
        </div>
        <div className="rounded-2xl border border-af-border bg-af-panel-2/40 p-4">
          <Heart className="w-5 h-5 text-pink-500 mb-2" />
          <div className="text-sm font-medium text-af-text">Open source</div>
          <div className="text-xs text-af-text-3">MIT licensed, no account</div>
        </div>
      </div>

      <UpdateSettings />

      {/* Links */}
      <div className="rounded-2xl border border-af-border bg-af-panel-2/40 p-5 space-y-3">
        <h4 className="text-sm font-semibold text-af-text">Links</h4>
        <button
          onClick={() => openUrl(REPO_URL)}
          className="flex items-center gap-3 w-full text-left px-3 py-2 rounded-md border border-af-border hover:border-af-accent/40 hover:bg-af-accent/10 transition-colors"
        >
          <Github className="w-4 h-4 text-af-text-2" />
          <span className="text-sm text-af-text">Source code on GitHub</span>
        </button>
        <button
          onClick={() => openUrl(`${REPO_URL}/blob/main/PRIVACY_POLICY.md`)}
          className="flex items-center gap-3 w-full text-left px-3 py-2 rounded-md border border-af-border hover:border-af-accent/40 hover:bg-af-accent/10 transition-colors"
        >
          <Shield className="w-4 h-4 text-af-text-2" />
          <span className="text-sm text-af-text">Privacy policy</span>
        </button>
      </div>

      <div className="text-center text-xs text-af-text-4 space-y-1">
        <p>
          Based on{" "}
          <button
            type="button"
            onClick={() => openUrl(ACTUALLY_FREE_URL)}
            className="text-af-accent hover:underline"
          >
            Meetily – Actually Free
          </button>{" "}
          and the{" "}
          <button
            type="button"
            onClick={() => openUrl(ORIGINAL_MEETILY_URL)}
            className="text-af-accent hover:underline"
          >
            open-source Meetily project
          </button>{" "}
          · MIT licensed
        </p>
      </div>
    </div>
  );
}
