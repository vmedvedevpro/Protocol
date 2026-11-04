'use client';

/**
 * The offer at the top of Settings › Transcription after an update (#88,
 * mockup N2): this computer has an Intel GPU without Whisper's Intel GPU
 * version, or an Intel NPU without Intel's libraries. Switch downloads what
 * is needed; the Intel GPU version then becomes the after-meeting model in
 * native code (`openvino_download` with `choose`), the NPU prepares itself
 * (#66). Not now is remembered per device (`lib/speech-choice.ts`).
 */
import { invoke } from '@tauri-apps/api/core';
import { Cpu } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { formatModelSize } from '@/lib/model-catalog';
import type { Offer } from '@/lib/speech-choice';
import { intelError, type CompanionStatus } from '@/lib/intel-gpu';
import { CANCELLED, downloadIntelLibraries } from '@/hooks/useIntelLibraries';
import { gpuInstalledNotice } from './ForThisComputer';

export interface IntelOfferProps {
  offer: Offer;
  /** The Intel GPU version's id (`openvino_status`), when the offer includes the GPU. */
  companionId: string | null;
  /** The regular copy, to ask `openvino_status` again after the download. */
  copy: string;
  onNotNow: () => void;
  /** After Switch started: the card shows the progress from here on. */
  onSwitch: () => void;
  /**
   * The switch ended. Unless it installed, the offer comes back (it is
   * unmounted meanwhile), with `error` when it failed rather than was
   * cancelled.
   */
  onSettled: (installed: boolean, error: string | null) => void;
  /** Why the last Switch failed, kept by the parent across the unmount. */
  error: string | null;
}

export function IntelOffer({ offer, companionId, copy, onNotNow, onSwitch, onSettled, error }: IntelOfferProps) {
  const size = formatModelSize(offer.bytes);
  const shown = error ? intelError(error) : null;

  const switchNow = () => {
    onSwitch();
    void (async () => {
      try {
        if (offer.gpu && companionId) {
          await invoke('openvino_download', { id: companionId, choose: true });
          const status = await invoke<CompanionStatus | null>('openvino_status', { whisperModel: copy }).catch(() => null);
          const notice = gpuInstalledNotice(status);
          toast.success(notice.title, { description: notice.description });
          onSettled(true, null);
        } else {
          const outcome = await downloadIntelLibraries();
          if (outcome === 'installed') {
            toast.success("Intel's libraries are installed", { description: 'Parakeet gets ready for the Intel NPU once, then runs on it.' });
          }
          // Running elsewhere: the card follows it, and the offer stays away meanwhile.
          onSettled(outcome !== 'cancelled', null);
        }
      } catch (failure) {
        const message = String(failure);
        const cancelled = message === CANCELLED;
        if (!cancelled) toast.error('The switch did not finish', { description: intelError(message).message });
        onSettled(false, cancelled ? null : message);
      }
    })();
  };

  return (
    <section
      aria-label="Intel GPU and NPU offer"
      className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-af-accent/30 bg-af-accent/[0.06] px-5 py-4"
    >
      <div className="flex min-w-0 flex-1 basis-72 items-start gap-3">
        <Cpu className="mt-0.5 h-5 w-5 shrink-0 text-af-accent" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-af-text">{offer.title}</p>
          <p className="mt-1 text-[13px] leading-relaxed text-af-text-3">
            {size ? `${offer.description} · ${size}` : offer.description}
          </p>
          {shown && (
            <p role="alert" className="mt-1 text-xs text-af-danger [overflow-wrap:anywhere]" title={shown.detail ?? undefined}>
              {shown.message}
            </p>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="sm" onClick={onNotNow}>Not now</Button>
        <Button variant="primary" size="sm" onClick={switchNow}>Switch</Button>
      </div>
    </section>
  );
}
