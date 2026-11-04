/**
 * How speech models are named in the UI. The model catalog gives each model a
 * display name; some repeat their engine ("Whisper tiny"), which reads oddly
 * next to the engine's own name, so it is dropped here. The id (what settings
 * store) is shown only when a model has no display name at all.
 */
import type { RawModelInfo } from '@/hooks/useTranscriptionModels';
import { isVisibleParakeetModel } from '@/lib/parakeet';

export type SpeechEngine = 'whisper' | 'parakeet';

/** A downloaded model that can transcribe, as the model pickers offer it. */
export interface InstalledSpeechModel {
  provider: SpeechEngine;
  name: string;
  displayName?: string;
  languages?: string[];
}

const ENGINE_NAMES: Record<SpeechEngine, string> = { whisper: 'Whisper', parakeet: 'Parakeet' };

export function speechEngineName(engine: SpeechEngine): string {
  return ENGINE_NAMES[engine];
}

/** The model's own name, without a leading engine name. */
export function speechModelName(engine: SpeechEngine, id: string, displayName?: string | null): string {
  const name = (displayName || '').trim();
  if (!name) return id;
  const prefix = new RegExp(`^${ENGINE_NAMES[engine]}\\s+`, 'i');
  return name.replace(prefix, '') || name;
}

/**
 * Whisper's Intel GPU version (#88): named after the model it serves, with
 * its device, so it reads apart from that model, which the Intel GPU
 * version can also run in place of (#79) and which then has the same badge.
 */
export const gpuVersionLabel = (version: { name: string; display_name?: string }) =>
  `${speechModelLabel('whisper', version.name, version.display_name)} · Intel GPU`;

/** "Whisper · Large V3 Turbo": the engine and model, for pickers that mix both engines. */
export function speechModelLabel(engine: SpeechEngine, id: string, displayName?: string | null): string {
  return `${ENGINE_NAMES[engine]} · ${speechModelName(engine, id, displayName)}`;
}

/** Catalog descriptions use "•"; the rest of the UI separates facts with "·". */
export function speechModelDescription(description?: string | null): string {
  return (description || '').replace(/\s*•\s*/g, ' · ').trim();
}

/** "25 languages", or "About 100 languages" for a model that lists all ("*"). */
export function speechModelLanguages(languages?: string[] | null): string | null {
  if (!languages || languages.length === 0) return null;
  if (languages.includes('*')) return 'About 100 languages';
  return `${languages.length} language${languages.length === 1 ? '' : 's'}`;
}

/**
 * The models the pickers offer: downloaded ones, Parakeet first. Parakeet v2
 * is no longer offered even while it is on disk (isVisibleParakeetModel).
 */
export function installedSpeechModels(whisper: RawModelInfo[], parakeet: RawModelInfo[]): InstalledSpeechModel[] {
  const pick = (provider: SpeechEngine) => (model: RawModelInfo): InstalledSpeechModel => ({
    provider,
    name: model.name,
    // speechModelLabel then reads as gpuVersionLabel.
    displayName: model.companion_of?.length
      ? `${speechModelName('whisper', model.name, model.display_name)} · Intel GPU`
      : model.display_name,
    languages: model.languages,
  });
  return [
    ...parakeet.filter((model) => model.status === 'Available' && isVisibleParakeetModel(model.name)).map(pick('parakeet')),
    ...whisper.filter((model) => model.status === 'Available').map(pick('whisper')),
  ];
}
