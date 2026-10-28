import React, { useState, useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { ChevronDown } from 'lucide-react';
import {
  ModelInfo,
  ModelStatus,
  WhisperAPI
} from '../lib/whisper';
import { Button } from '@/components/ui/button';
import { ModelUpdateControl } from './ModelUpdateControl';
import { ModelList, ModelRow } from './settings/ModelRow';
import { useModelCatalog } from '@/lib/model-catalog';
import { speechModelDescription, speechModelName } from '@/lib/speech-models';

interface ModelManagerProps {
  selectedModel?: string;
  /** Runs when a download finishes (with its name) and when the selected model is removed (with ''). */
  onModelSelect?: (modelName: string) => void | boolean | Promise<void | boolean>;
  /** Runs after any model was removed from disk. */
  onModelRemoved?: (modelName: string) => void;
  /**
   * Removes a model another owner manages (the optional post-call model is
   * uninstalled natively); true when it took the removal. Its native event
   * lists the models again here.
   */
  removeModel?: (modelName: string) => boolean;
  /**
   * Downloads a model another owner manages (the optional post-call model is
   * downloaded and enabled natively); true when it took the download. Its
   * native progress events still update the row.
   */
  startModelDownload?: (modelName: string) => boolean;
  /** Where an installed model is in use, shown on its row ("Used after meetings"). */
  usageFor?: (modelName: string) => string[];
  className?: string;
  autoSave?: boolean;
}

export function ModelManager({
  selectedModel,
  onModelSelect,
  onModelRemoved,
  removeModel,
  startModelDownload,
  usageFor,
  className = '',
  autoSave = false
}: ModelManagerProps) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [downloadingModels, setDownloadingModels] = useState<Set<string>>(new Set());
  const [showMore, setShowMore] = useState(false);
  // Names in the main list when the models first loaded, in that order.
  const firstListed = useRef<string[] | null>(null);

  // Refs for stable callbacks
  const onModelSelectRef = useRef(onModelSelect);
  const autoSaveRef = useRef(autoSave);

  // Progress throttle map to prevent rapid updates
  const progressThrottleRef = useRef<Map<string, { progress: number; timestamp: number }>>(new Map());

  // A new model list or a finished model update: list the models again.
  const catalog = useModelCatalog(() => {
    WhisperAPI.getAvailableModels().then(setModels).catch(() => {});
  }, ['whisper']);

  // Update refs when props change
  useEffect(() => {
    onModelSelectRef.current = onModelSelect;
    autoSaveRef.current = autoSave;
  }, [onModelSelect, autoSave]);

  // Load persisted downloading state from localStorage
  const getPersistedDownloadingModels = (): Set<string> => {
    try {
      const saved = localStorage.getItem('downloading-models');
      return saved ? new Set<string>(JSON.parse(saved) as string[]) : new Set<string>();
    } catch {
      return new Set<string>();
    }
  };

  // Persist downloading state to localStorage
  const updateDownloadingModels = (updater: (prev: Set<string>) => Set<string>) => {
    setDownloadingModels(prev => {
      const newSet = updater(prev);
      localStorage.setItem('downloading-models', JSON.stringify(Array.from(newSet)));
      return newSet;
    });
  };

  // Initialize models
  useEffect(() => {
    if (initialized) return;

    const initializeModels = async () => {
      try {
        setLoading(true);
        await WhisperAPI.init();
        const modelList = await WhisperAPI.getAvailableModels();

        // Apply persisted downloading states
        const persistedDownloading = getPersistedDownloadingModels();
        const modelsWithDownloadState = modelList.map(model => {
          if (persistedDownloading.has(model.name) && model.status !== 'Available') {
            if (typeof model.status === 'object' && 'Corrupted' in model.status) {
              updateDownloadingModels(prev => {
                const newSet = new Set(prev);
                newSet.delete(model.name);
                return newSet;
              });
              return model;
            } else if (model.status === 'Missing') {
              updateDownloadingModels(prev => {
                const newSet = new Set(prev);
                newSet.delete(model.name);
                return newSet;
              });
              return model;
            } else {
              return { ...model, status: { Downloading: 0 } as ModelStatus };
            }
          }
          return model;
        });

        setModels(modelsWithDownloadState);
        setInitialized(true);
      } catch (err) {
        console.error('Failed to initialize Whisper:', err);
        setError(err instanceof Error ? err.message : 'Failed to load models');
        toast.error('Failed to load transcription models', {
          description: err instanceof Error ? err.message : 'Unknown error',
          duration: 5000
        });
      } finally {
        setLoading(false);
      }
    };

    initializeModels();
  }, [initialized, selectedModel, onModelSelect]);

  // Set up event listeners for download progress
  useEffect(() => {
    let unlistenProgress: (() => void) | null = null;
    let unlistenComplete: (() => void) | null = null;
    let unlistenError: (() => void) | null = null;

    const setupListeners = async () => {
      console.log('[ModelManager] Setting up event listeners...');

      // Download progress with throttling
      unlistenProgress = await listen<{ modelName: string; progress: number }>(
        'model-download-progress',
        (event) => {
          const { modelName, progress } = event.payload;
          const now = Date.now();
          const throttleData = progressThrottleRef.current.get(modelName);

          // Throttle: only update if 300ms passed OR progress jumped by 5%+
          const shouldUpdate = !throttleData ||
            now - throttleData.timestamp > 300 ||
            Math.abs(progress - throttleData.progress) >= 5;

          if (shouldUpdate) {
            console.log(`[ModelManager] Progress update for ${modelName}: ${progress}%`);
            progressThrottleRef.current.set(modelName, { progress, timestamp: now });

            setModels(prevModels =>
              prevModels.map(model =>
                model.name === modelName
                  ? { ...model, status: { Downloading: progress } as ModelStatus }
                  : model
              )
            );
          }
        }
      );

      // Download complete
      unlistenComplete = await listen<{ modelName: string; postCallManaged?: boolean }>(
        'model-download-complete',
        (event) => {
          const { modelName } = event.payload;
          const model = models.find(m => m.name === modelName);
          const displayName = getDisplayName(modelName);

          setModels(prevModels =>
            prevModels.map(model =>
              model.name === modelName
                ? { ...model, status: 'Available' as ModelStatus }
                : model
            )
          );

          setDownloadingModels(prev => {
            const newSet = new Set(prev);
            newSet.delete(modelName);
            return newSet;
          });

          // Clean up throttle data
          progressThrottleRef.current.delete(modelName);

          // Optional setup owns its native post-call activation and notification.
          // A model manager in another view must not also change the live model.
          if (event.payload.postCallManaged) return;

          toast.success(`${displayName} ready`, {
            description: 'Model downloaded and ready to use',
            duration: 4000
          });

          // Auto-select after download using stable refs
          if (onModelSelectRef.current) {
            onModelSelectRef.current(modelName);
            if (autoSaveRef.current) {
              saveModelSelection(modelName);
            }
          }
        }
      );

      // Download error
      unlistenError = await listen<{ modelName: string; error: string; postCallManaged?: boolean }>(
        'model-download-error',
        (event) => {
          const { modelName, error } = event.payload;
          const displayName = getDisplayName(modelName);
          // Cancel ends the native download with an error too; cancelDownload
          // already reset the row and said so.
          const cancelled = error.includes('Download cancelled by user');

          setModels(prevModels =>
            prevModels.map(model =>
              model.name === modelName
                ? { ...model, status: (cancelled ? 'Missing' : error.startsWith('Model downloaded, but could not enable it:') ? 'Available' : { Error: error }) as ModelStatus }
                : model
            )
          );

          setDownloadingModels(prev => {
            const newSet = new Set(prev);
            newSet.delete(modelName);
            return newSet;
          });

          // Clean up throttle data
          progressThrottleRef.current.delete(modelName);

          if (event.payload.postCallManaged || cancelled) return;

          toast.error(`Failed to download ${displayName}`, {
            description: error,
            duration: 6000,
            action: {
              label: 'Retry',
              onClick: () => downloadModel(modelName)
            }
          });
        }
      );
    };

    setupListeners();

    return () => {
      console.log('[ModelManager] Cleaning up event listeners...');
      if (unlistenProgress) unlistenProgress();
      if (unlistenComplete) unlistenComplete();
      if (unlistenError) unlistenError();
    };
  }, []); // Empty dependency array - listeners use refs for stable callbacks

  const saveModelSelection = async (modelName: string) => {
    try {
      await invoke('api_save_transcript_config', {
        provider: 'localWhisper',
        model: modelName,
        apiKey: null
      });
      return true;
    } catch (error) {
      console.error('Failed to save model selection:', error);
      return false;
    }
  };

  useEffect(() => {
    let disposed = false;
    const stop = listen<string>('optional-model-removed', async ({ payload }) => {
      if (payload !== 'whisper') return;
      try {
        const models = await WhisperAPI.getAvailableModels();
        if (!disposed) setModels(models);
      } catch (error) { console.error('Could not refresh models after uninstall:', error); }
    });
    return () => { disposed = true; void stop.then(unlisten => unlisten()).catch(console.error); };
  }, []);

  const cancelDownload = async (modelName: string) => {
    const displayName = getDisplayName(modelName);

    try {
      await WhisperAPI.cancelDownload(modelName);

      updateDownloadingModels(prev => {
        const newSet = new Set(prev);
        newSet.delete(modelName);
        return newSet;
      });

      setModels(prevModels =>
        prevModels.map(model =>
          model.name === modelName
            ? { ...model, status: 'Missing' as ModelStatus }
            : model
        )
      );

      // Clean up throttle data
      progressThrottleRef.current.delete(modelName);

      toast.info(`${displayName} download cancelled`, {
        duration: 3000
      });
    } catch (err) {
      console.error('Failed to cancel download:', err);
      toast.error('Failed to cancel download', {
        description: err instanceof Error ? err.message : 'Unknown error',
        duration: 4000
      });
    }
  };

  const downloadModel = async (modelName: string) => {
    if (downloadingModels.has(modelName)) return;
    if (startModelDownload?.(modelName)) {
      setModels(prevModels =>
        prevModels.map(model =>
          model.name === modelName ? { ...model, status: { Downloading: 0 } as ModelStatus } : model
        )
      );
      return;
    }

    const displayName = getDisplayName(modelName);

    try {
      updateDownloadingModels(prev => new Set([...prev, modelName]));

      setModels(prevModels =>
        prevModels.map(model =>
          model.name === modelName
            ? { ...model, status: { Downloading: 0 } as ModelStatus }
            : model
        )
      );

      toast.info(`Downloading ${displayName}...`, {
        description: 'This may take a few minutes',
        duration: 5000
      });

      await WhisperAPI.downloadModel(modelName);
    } catch (err) {
      console.error('Download failed:', err);
      updateDownloadingModels(prev => {
        const newSet = new Set(prev);
        newSet.delete(modelName);
        return newSet;
      });

      const errorMessage = err instanceof Error ? err.message : 'Download failed';
      setModels(prev =>
        prev.map(model =>
          model.name === modelName ? { ...model, status: { Error: errorMessage } } : model
        )
      );
    }
  };

  const deleteModel = async (modelName: string) => {
    if (removeModel?.(modelName)) return;
    const displayName = getDisplayName(modelName);

    try {
      await WhisperAPI.deleteCorruptedModel(modelName);

      // Refresh models list
      const modelList = await WhisperAPI.getAvailableModels();
      setModels(modelList);

      toast.success(`${displayName} deleted`, {
        description: 'Model removed to free up space',
        duration: 3000
      });

      onModelRemoved?.(modelName);
      // If deleted model was selected, clear selection
      if (selectedModel === modelName && onModelSelect) {
        onModelSelect('');
      }
    } catch (err) {
      console.error('Failed to delete model:', err);
      toast.error(`Failed to delete ${displayName}`, {
        description: err instanceof Error ? err.message : 'Delete failed',
        duration: 4000
      });
    }
  };

  // Names, tiers and recommendations come from the model catalog.
  const getDisplayName = (modelName: string): string =>
    models.find((model) => model.name === modelName)?.display_name || `Whisper ${modelName}`;

  if (loading) {
    return (
      <div className={`space-y-2 ${className}`}>
        <div className="af-skeleton h-14 rounded-xl" />
        <div className="af-skeleton h-14 rounded-xl" />
      </div>
    );
  }

  if (error) {
    return (
      <div className={`bg-af-danger/10 border border-af-danger/35 rounded-lg p-4 ${className}`}>
        <p className="text-sm text-af-danger">Failed to load models</p>
        <p className="text-xs text-af-danger mt-1">{error}</p>
      </div>
    );
  }

  // The list shows what was on this computer (or on its way) when it first
  // loaded, then the catalog's recommendation; every other model waits behind
  // "More models", the catalog's basic tier first. A row keeps its place while
  // it downloads, fails or finishes, so it never moves away from the pointer;
  // with "More models" closed, such a row shows in the list instead.
  const inUse = (model: ModelInfo) => model.status !== 'Missing';
  if (firstListed.current === null && models.length > 0) {
    firstListed.current = [
      ...models.filter(inUse),
      ...models.filter((model) => !inUse(model) && model.recommended),
    ].map((model) => model.name);
  }
  const pinned = firstListed.current ?? [];
  const mainModels = [
    ...pinned.flatMap((name) => models.filter((model) => model.name === name)),
    ...(showMore ? [] : models.filter((model) => !pinned.includes(model.name) && inUse(model))),
  ];
  const rest = models.filter((model) => !mainModels.includes(model));
  const moreModels = [
    ...rest.filter((model) => model.tier === 'basic'),
    ...rest.filter((model) => model.tier !== 'basic'),
  ];
  const row = (model: ModelInfo) => (
    <ModelRow
      key={model.name}
      name={speechModelName('whisper', model.name, model.display_name)}
      description={speechModelDescription(model.description)}
      facts={[`${model.accuracy} accuracy`, `${model.speed} speed`]}
      sizeBytes={model.size_bytes}
      status={model.status}
      recommended={model.recommended === true}
      usage={usageFor?.(model.name)}
      onDownload={() => downloadModel(model.name)}
      onCancel={() => cancelDownload(model.name)}
      onRemove={() => deleteModel(model.name)}
      footer={<ModelUpdateControl catalog={catalog} engine="whisper" id={model.name} installed={model.status === 'Available'} />}
    />
  );

  return (
    <div className={`space-y-2 ${className}`}>
      {mainModels.length > 0 && <ModelList label="Whisper models">{mainModels.map(row)}</ModelList>}
      {moreModels.length > 0 && (
        <>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setShowMore((open) => !open)}
            aria-expanded={showMore}
            className="text-af-text-3"
          >
            <ChevronDown className={`transition-transform ${showMore ? 'rotate-180' : ''}`} />
            {showMore ? 'Fewer models' : mainModels.length === 0 ? `Show ${moreModels.length} models` : `${moreModels.length} more model${moreModels.length === 1 ? '' : 's'}`}
          </Button>
          {showMore && <ModelList label="More Whisper models">{moreModels.map(row)}</ModelList>}
        </>
      )}
    </div>
  );
}
