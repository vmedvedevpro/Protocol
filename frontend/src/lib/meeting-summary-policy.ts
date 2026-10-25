export function shouldSetUpAutoSummary(source: string | null, isAutoSummaryEnabled: boolean): boolean {
  return source === 'recording' && isAutoSummaryEnabled;
}

/**
 * Whether auto-summary keeps the saved summary model instead of trying the
 * first-run gemma3:1b fallback. A saved provider the app no longer offers loads
 * with an empty provider (see api_get_model_config); that row was configured,
 * so the summary attempt asks for another provider rather than switching.
 */
export function keepsSavedSummaryModel(
  config: { provider?: string | null; model?: string | null } | null | undefined
): boolean {
  return !!config && (!!config.model || config.provider === '');
}
