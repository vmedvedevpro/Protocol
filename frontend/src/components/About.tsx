import React, { useState, useEffect } from "react";
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import Image from 'next/image';
import { Button } from './ui/button';
import { Github } from 'lucide-react';
import { toast } from 'sonner';

const REPO_URL = 'https://github.com/vmedvedevpro/Protocol';
const ACTUALLY_FREE_URL = 'https://github.com/TylerBuza/Meetily-ActuallyFree';
const MEETILY_URL = 'https://github.com/Zackriya-Solutions/meetily';

export function About() {
    const [currentVersion, setCurrentVersion] = useState<string>('0.0.1');

    useEffect(() => {
        // Get current version on mount
        getVersion().then(setCurrentVersion).catch(console.error);
    }, []);

    const openExternal = (url: string) => {
        invoke('open_external_url', { url }).catch((error) => {
            console.error('Failed to open external link:', error);
            toast.error('Could not open the link');
        });
    };

    return (
        <div className="p-4 space-y-4 h-[80vh] overflow-y-auto">
            {/* Compact Header */}
            <div className="text-center">
                <div className="mb-3">
                    <Image
                        src="icon_128x128.png"
                        alt="Protocol Logo"
                        width={64}
                        height={64}
                        className="mx-auto"
                    />
                </div>
                <h1 className="text-xl font-bold text-af-text">Protocol</h1>
                <span className="text-sm text-af-text-3"> v{currentVersion}</span>
                <p className="text-medium text-af-text-2 mt-1">
                    Real-time notes and summaries that never leave your machine.
                </p>
                <div className="mt-3">
                    <Button
                        onClick={() => openExternal(REPO_URL)}
                        variant="outline"
                        size="sm"
                        className="text-xs"
                    >
                        <Github className="h-3 w-3 mr-2" />
                        Source code on GitHub
                    </Button>
                </div>
            </div>

            {/* Features Grid - Compact */}
            <div className="space-y-3">
                <h2 className="text-base font-semibold text-af-text">What makes Protocol different</h2>
                <div className="grid grid-cols-2 gap-2">
                    <div className="bg-af-panel-2 rounded p-3 hover:bg-af-panel-2 transition-colors">
                        <h3 className="font-bold text-sm text-af-text mb-1">Privacy-first</h3>
                        <p className="text-xs text-af-text-2 leading-relaxed">Your data & AI processing workflow can now stay within your premise. No cloud, no leaks.</p>
                    </div>
                    <div className="bg-af-panel-2 rounded p-3 hover:bg-af-panel-2 transition-colors">
                        <h3 className="font-bold text-sm text-af-text mb-1">Use Any Model</h3>
                        <p className="text-xs text-af-text-2 leading-relaxed">Prefer local open-source model? Great. Want to plug in an external API? Also fine. No lock-in.</p>
                    </div>
                    <div className="bg-af-panel-2 rounded p-3 hover:bg-af-panel-2 transition-colors">
                        <h3 className="font-bold text-sm text-af-text mb-1">Cost-Smart</h3>
                        <p className="text-xs text-af-text-2 leading-relaxed">Avoid pay-per-minute bills by running models locally (or pay only for the calls you choose).</p>
                    </div>
                    <div className="bg-af-panel-2 rounded p-3 hover:bg-af-panel-2 transition-colors">
                        <h3 className="font-bold text-sm text-af-text mb-1">Works everywhere</h3>
                        <p className="text-xs text-af-text-2 leading-relaxed">Google Meet, Zoom, Teams, Discord — online or offline.</p>
                    </div>
                </div>
            </div>

            {/* Footer - Compact */}
            <div className="pt-2 border-t border-af-border text-center">
                <p className="text-xs text-af-text-4">
                    Protocol · Open source (MIT)
                </p>
                <p className="mt-1 text-xs text-af-text-3">
                    Based on{' '}
                    <button
                        type="button"
                        className="underline underline-offset-2 transition-colors hover:text-af-accent"
                        onClick={() => openExternal(ACTUALLY_FREE_URL)}
                    >
                        Meetily – Actually Free
                    </button>
                    {' '}and{' '}
                    <button
                        type="button"
                        className="underline underline-offset-2 transition-colors hover:text-af-accent"
                        onClick={() => openExternal(MEETILY_URL)}
                    >
                        Meetily
                    </button>
                </p>
            </div>
        </div>

    )
}
