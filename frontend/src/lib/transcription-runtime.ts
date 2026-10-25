export const TRANSCRIPTION_RUNTIME_ERROR = 'TRANSCRIPTION_RUNTIME_INITIALIZATION_FAILED';

export function transcriptionRuntimeMessage(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.startsWith(TRANSCRIPTION_RUNTIME_ERROR)) return null;
  return message.slice(TRANSCRIPTION_RUNTIME_ERROR.length).replace(/^:\s*/, '') ||
    'Speech recognition could not initialize. Restart Protocol; if it continues, repair or reinstall the app.';
}
