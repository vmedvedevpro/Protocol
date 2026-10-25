'use client'

import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { usePlatform } from '@/hooks/usePlatform';
import type { CudaReconfigurationStatus } from '@/lib/transcription-acceleration';

// Windows-only launch check: tells the user when a usable NVIDIA driver appeared
// after setup picked a non-CUDA build, or when the driver is too old for CUDA.
// Renders nothing; the result is shown as a toast once onboarding is complete.
export function CudaReconfigurationNotice({ onboardingCompleted = false }: { onboardingCompleted?: boolean }) {
  const platform = usePlatform();

  useEffect(() => {
    if (platform !== 'windows' || !onboardingCompleted) return;

    let cancelled = false;
    invoke<CudaReconfigurationStatus>('get_cuda_reconfiguration_status')
      .then((status) => {
        if (cancelled) return;

        const reconfigurationUrl = status.setupDownloadUrl;
        if (status.reconfigurationRequired && reconfigurationUrl) {
          toast.warning('NVIDIA CUDA is ready', {
            id: 'cuda-reconfiguration-status',
            description: `Rerun Protocol setup to replace the ${status.compiledBackend} build with the CUDA build.`,
            duration: 30000,
            action: {
              label: 'Download setup',
              onClick: () => {
                void invoke('open_external_url', { url: reconfigurationUrl });
              },
            },
          });
        } else if (status.driverUpdateRequired) {
          toast.warning('NVIDIA driver update recommended', {
            id: 'cuda-reconfiguration-status',
            description: 'Install a current NVIDIA driver, then reopen Protocol to recheck CUDA support.',
            duration: 30000,
            action: {
              label: 'Get driver',
              onClick: () => {
                void invoke('open_external_url', {
                  url: 'https://www.nvidia.com/Download/index.aspx',
                });
              },
            },
          });
        }
      })
      .catch((error) => console.error('Failed to recheck CUDA availability:', error));

    return () => {
      cancelled = true;
    };
  }, [onboardingCompleted, platform]);

  return null;
}
