import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AlertTriangle, AudioLines, BookOpen, Check, ChevronRight, Globe, Radio, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { OPTIONAL_MODEL_PREFERENCES_CHANGED } from '@/lib/optional-model-activation';
import { OPTIONAL_WHISPER_MODEL, useOptionalModelDownloads } from '@/contexts/OptionalModelDownloadsContext';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from './ui/select';
import { Switch } from './ui/switch';
import { Textarea } from './ui/textarea';
import { RecordingPreferences } from './RecordingSettings';
import { ModelManager } from './WhisperModelManager';
import { ParakeetModelManager } from './ParakeetModelManager';
import { DeviceBadge, ForThisComputer } from './settings/ForThisComputer';
import { IntelOffer } from './settings/IntelOffer';
import { LANGUAGES } from './LanguageSelection';
import { RowNote, SettingRow, SettingsGroup } from './settings/SettingsGroup';
import type { RawModelInfo } from '@/hooks/useTranscriptionModels';
import { getModelDisplayInfo } from '@/lib/parakeet';
import { installedSpeechModels, speechModelLabel, speechModelLanguages, type InstalledSpeechModel, type SpeechEngine } from '@/lib/speech-models';
import { deviceOf, npuOwnsParakeet, offerFor, readDismissed, writeDismissed, type Device } from '@/lib/speech-choice';
import { useLabs } from '@/hooks/useLabs';
import { useSpeechChoice } from '@/hooks/useSpeechChoice';

export interface TranscriptModelProps {
    provider: 'localWhisper' | 'parakeet' | 'deepgram' | 'elevenLabs' | 'groq' | 'openai';
    model: string;
    apiKey?: string | null;
}

export interface TranscriptSettingsProps {
    transcriptModelConfig: TranscriptModelProps;
    setTranscriptModelConfig: (config: TranscriptModelProps) => void;
    /** Runs after the live model was saved (the recorder's setup dialog closes on it). */
    onModelSelect?: () => void;
    /** The meeting language Whisper transcribes in; the row is left out without it. */
    language?: { value: string; onChange: (code: string) => void; disabled?: boolean };
    /** Rendered between the vocabulary and the model lists (Settings puts Speakers there). */
    speakerSettings?: ReactNode;
}

interface VocabularyConfig {
    global: string;
    meeting: string;
}

interface PostCallTranscriptConfig {
    provider: 'live' | 'whisper' | 'parakeet';
    model: string;
}

type InstalledModel = InstalledSpeechModel;

const DEFAULT_POST_CALL_CONFIG: PostCallTranscriptConfig = {
    provider: 'live',
    model: '',
};

const keyOf = (provider: SpeechEngine, name: string) => `${provider}:${name}`;
const labelOf = (model: InstalledModel) => speechModelLabel(model.provider, model.name, model.displayName);
// A saved model that is not installed has no catalog name at hand; Parakeet's are known here.
const missingLabel = (provider: SpeechEngine, name: string) =>
    speechModelLabel(provider, name, provider === 'parakeet' ? getModelDisplayInfo(name)?.friendlyName : undefined);
// The live select's entry that opens Speech models › All models.
const ALL_MODELS = '__all-models';
const AUTO_LANGUAGE_NAMES: Record<string, string> = {
    auto: 'Detect automatically',
    'auto-translate': 'Detect and translate to English',
};

export function TranscriptSettings({ transcriptModelConfig, setTranscriptModelConfig, onModelSelect, language, speakerSettings }: TranscriptSettingsProps) {
    const { jobs, startDownload, uninstallModel } = useOptionalModelDownloads();
    const whisperJob = jobs.whisper;
    const choice = useSpeechChoice();
    const [allModelsOpen, setAllModelsOpen] = useState(false);
    const [dismissed, setDismissed] = useState<Device[]>(() => readDismissed());
    const [switching, setSwitching] = useState(false);
    const [uiProvider, setUiProvider] = useState<TranscriptModelProps['provider']>(transcriptModelConfig.provider);
    const [installedModels, setInstalledModels] = useState<InstalledModel[]>([]);
    const [installedLoaded, setInstalledLoaded] = useState(false);
    const [isSavingLive, setIsSavingLive] = useState(false);
    const [postCallConfig, setPostCallConfig] = useState<PostCallTranscriptConfig>(DEFAULT_POST_CALL_CONFIG);
    const [isLoadingPostCall, setIsLoadingPostCall] = useState(true);
    const [isSavingPostCall, setIsSavingPostCall] = useState(false);
    const [postCallSaved, setPostCallSaved] = useState(false);
    const [postCallError, setPostCallError] = useState<string | null>(null);
    const [vocabulary, setVocabulary] = useState('');
    const [savedVocabulary, setSavedVocabulary] = useState('');
    const [isSavingVocabulary, setIsSavingVocabulary] = useState(false);
    const [vocabularySaved, setVocabularySaved] = useState(false);
    const [vocabularyError, setVocabularyError] = useState<string | null>(null);
    const [realTimeTranscription, setRealTimeTranscription] = useState(false);
    // Labs speech options that are on are named on the engine they change.
    const { labs } = useLabs();
    const vocabularyRevisionRef = useRef(0);
    const liveSaveInFlightRef = useRef(false);
    const postCallSaveInFlightRef = useRef(false);
    const postCallRevisionRef = useRef(0);
    const afterMeetingRef = useRef<HTMLDivElement>(null);
    const modelsRef = useRef<HTMLElement>(null);
    const allModelsRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let disposed = false;
        const refreshPostCall = () => {
            if (postCallSaveInFlightRef.current) return;
            const revision = ++postCallRevisionRef.current;
            void invoke<PostCallTranscriptConfig>('api_get_post_call_transcript_config').then(config => {
                if (!disposed && revision === postCallRevisionRef.current) {
                    setPostCallConfig(config);
                    setPostCallError(null);
                }
            }).catch(error => console.error('Could not refresh activated post-call model:', error));
        };
        window.addEventListener(OPTIONAL_MODEL_PREFERENCES_CHANGED, refreshPostCall);
        return () => { disposed = true; window.removeEventListener(OPTIONAL_MODEL_PREFERENCES_CHANGED, refreshPostCall); };
    }, []);

    useEffect(() => {
        invoke<RecordingPreferences>('get_recording_preferences')
            .then((p) => setRealTimeTranscription(p.real_time_transcription ?? false))
            .catch(() => {});
    }, []);

    const handleToggleRealTime = async (checked: boolean) => {
        setRealTimeTranscription(checked);
        try {
            const prefs = await invoke<RecordingPreferences>('get_recording_preferences');
            await invoke('set_recording_preferences', { preferences: { ...prefs, real_time_transcription: checked } });
            toast.success(checked ? 'Faster live text is on' : 'Faster live text is off', {
                description: checked
                    ? 'Words appear sooner while you record.'
                    : 'Live text uses the standard pace.'
            });
        } catch (e) {
            console.error('Failed to update real-time transcription preference:', e);
            setRealTimeTranscription(!checked);
            toast.error('Could not change faster live text');
        }
    };

    const refreshInstalledModels = useCallback(async () => {
        const [whisperModels, parakeetModels] = await Promise.all([
            invoke<RawModelInfo[]>('whisper_get_available_models').catch(() => []),
            invoke<RawModelInfo[]>('parakeet_get_available_models').catch(() => []),
        ]);
        setInstalledModels(installedSpeechModels(whisperModels, parakeetModels));
        setInstalledLoaded(true);
    }, []);

    useEffect(() => {
        setUiProvider(transcriptModelConfig.provider);
    }, [transcriptModelConfig.provider]);

    // Setup downloads can finish while this Settings page remains mounted.
    // Refresh installed choices as well as the preference-change subscription.
    useEffect(() => {
        if (whisperJob.status === 'ready' || whisperJob.status === 'idle' || whisperJob.status === 'activation-error') void refreshInstalledModels();
    }, [whisperJob.status, refreshInstalledModels]);

    // The Enhance transcript dialog links here to install Whisper: the For
    // this computer card downloads it.
    useEffect(() => {
        const requestedSection = sessionStorage.getItem('meetily-settings-transcription-section');
        sessionStorage.removeItem('meetily-settings-transcription-section');
        sessionStorage.removeItem('meetily-settings-transcription-provider');
        if (requestedSection === 'post-call') {
            window.setTimeout(() => modelsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
        }
    }, []);

    useEffect(() => {
        void refreshInstalledModels();
        const revision = postCallRevisionRef.current;
        invoke<PostCallTranscriptConfig>('api_get_post_call_transcript_config')
            .then((config) => { if (revision === postCallRevisionRef.current) setPostCallConfig(config || DEFAULT_POST_CALL_CONFIG); })
            .catch((error) => {
                console.error('Failed to load post-call transcription config:', error);
                setPostCallError('Could not load the after-meeting model.');
            })
            .finally(() => setIsLoadingPostCall(false));
    }, [refreshInstalledModels]);

    useEffect(() => {
        const revision = vocabularyRevisionRef.current;
        invoke<VocabularyConfig>('api_get_vocabulary', { meetingId: null })
            .then((config) => {
                if (vocabularyRevisionRef.current === revision) {
                    setVocabulary(config.global || '');
                }
                setSavedVocabulary(config.global || '');
            })
            .catch((error) => {
                console.error('Failed to load vocabulary:', error);
                setVocabularyError('Could not load the saved vocabulary.');
            });
    }, []);

    const saveLiveConfig = async (provider: 'localWhisper' | 'parakeet', model: string): Promise<boolean> => {
        if (liveSaveInFlightRef.current) return false;
        liveSaveInFlightRef.current = true;
        setIsSavingLive(true);
        const nextConfig: TranscriptModelProps = {
            ...transcriptModelConfig,
            provider,
            model,
            apiKey: null,
        };
        try {
            await invoke('api_save_transcript_config', {
                provider,
                model,
                apiKey: null,
            });
            setUiProvider(provider);
            setTranscriptModelConfig(nextConfig);
            onModelSelect?.();
            return true;
        } catch (error) {
            toast.error('Could not save the live transcription model', {
                description: typeof error === 'string' ? error : String(error),
            });
            return false;
        } finally {
            liveSaveInFlightRef.current = false;
            setIsSavingLive(false);
        }
    };

    const savePostCallConfig = async (nextConfig: PostCallTranscriptConfig): Promise<boolean> => {
        if (postCallSaveInFlightRef.current) return false;
        postCallSaveInFlightRef.current = true;
        const previousConfig = postCallConfig;
        const revision = ++postCallRevisionRef.current;
        setPostCallConfig(nextConfig);
        setIsSavingPostCall(true);
        setPostCallSaved(false);
        setPostCallError(null);
        try {
            await invoke('api_save_post_call_transcript_config', {
                provider: nextConfig.provider,
                model: nextConfig.model,
            });
            window.dispatchEvent(new Event(OPTIONAL_MODEL_PREFERENCES_CHANGED));
            if (postCallRevisionRef.current === revision) {
                setPostCallSaved(true);
                window.setTimeout(() => setPostCallSaved(false), 2000);
            }
            return true;
        } catch (error) {
            if (postCallRevisionRef.current === revision) {
                setPostCallConfig(previousConfig);
                setPostCallError(typeof error === 'string' ? error : String(error));
            }
            return false;
        } finally {
            postCallSaveInFlightRef.current = false;
            if (postCallRevisionRef.current === revision) {
                setIsSavingPostCall(false);
            }
        }
    };

    // A finished download becomes the model for the step it suits: Parakeet
    // while recording, Whisper after the meeting.
    const handleParakeetDownloaded = async (modelName: string) => {
        if (!modelName) return;
        const saved = await saveLiveConfig('parakeet', modelName);
        void refreshInstalledModels();
        return saved;
    };

    const handleWhisperDownloaded = async (modelName: string) => {
        void refreshInstalledModels();
        if (!modelName) return true;
        return savePostCallConfig({ provider: 'whisper', model: modelName });
    };

    // A removed model must not stay chosen: after meetings falls back to the
    // live model, and live Whisper falls back to Parakeet when it is installed.
    const handleWhisperRemoved = async (modelName: string) => {
        void refreshInstalledModels();
        if (postCallConfig.provider === 'whisper' && postCallConfig.model === modelName) {
            await savePostCallConfig(DEFAULT_POST_CALL_CONFIG);
        }
        if (uiProvider === 'localWhisper' && transcriptModelConfig.model === modelName) {
            const parakeetFallback = installedModels.find((model) => model.provider === 'parakeet');
            if (parakeetFallback) await saveLiveConfig('parakeet', parakeetFallback.name);
        }
    };

    const saveVocabulary = async () => {
        setIsSavingVocabulary(true);
        setVocabularySaved(false);
        setVocabularyError(null);
        const revision = vocabularyRevisionRef.current;
        try {
            const normalized = await invoke<string>('api_save_global_vocabulary', { vocabulary });
            if (vocabularyRevisionRef.current === revision) {
                setVocabulary(normalized);
            }
            setSavedVocabulary(normalized);
            setVocabularySaved(true);
            window.setTimeout(() => setVocabularySaved(false), 2000);
        } catch (error) {
            setVocabularyError(typeof error === 'string' ? error : String(error));
        } finally {
            setIsSavingVocabulary(false);
        }
    };

    const liveEngine: SpeechEngine | null = uiProvider === 'localWhisper' ? 'whisper' : uiProvider === 'parakeet' ? 'parakeet' : null;
    const liveKey = liveEngine ? keyOf(liveEngine, transcriptModelConfig.model) : '';
    const liveModel = installedModels.find((model) => keyOf(model.provider, model.name) === liveKey);

    // The model enhancement will actually run with, chosen the way
    // PostCallProcessingWorker's resolveEnhancementModel chooses it.
    const followsLive = postCallConfig.provider === 'live';
    const afterEngine: SpeechEngine | null = followsLive ? liveEngine : postCallConfig.provider as SpeechEngine;
    const afterName = followsLive ? transcriptModelConfig.model : postCallConfig.model;
    const afterExact = afterEngine ? installedModels.find((model) => model.provider === afterEngine && model.name === afterName) : undefined;
    const afterModel = afterExact
        ?? (afterEngine
            ? installedModels.find((model) => model.provider === afterEngine)
            : installedModels.find((model) => model.provider === 'parakeet') ?? installedModels[0]);
    const afterKey = followsLive ? 'live' : keyOf(postCallConfig.provider as SpeechEngine, postCallConfig.model);

    const usesWhisper = liveModel?.provider === 'whisper' || afterModel?.provider === 'whisper';

    const usageFor = (engine: SpeechEngine) => (name: string) => [
        ...(liveModel?.provider === engine && liveModel.name === name ? ['During meetings'] : []),
        ...(afterModel?.provider === engine && afterModel.name === name ? ['After meetings'] : []),
    ];

    const chooseLive = (key: string) => {
        if (key === ALL_MODELS) {
            openAllModels();
            return;
        }
        const model = installedModels.find((entry) => keyOf(entry.provider, entry.name) === key);
        if (!model || isSavingLive) return;
        void saveLiveConfig(model.provider === 'whisper' ? 'localWhisper' : 'parakeet', model.name);
    };

    const chooseAfter = (key: string) => {
        if (isLoadingPostCall || isSavingPostCall) return;
        if (key === 'live') {
            void savePostCallConfig(DEFAULT_POST_CALL_CONFIG);
            return;
        }
        const model = installedModels.find((entry) => keyOf(entry.provider, entry.name) === key);
        if (model) void savePostCallConfig({ provider: model.provider, model: model.name });
    };

    const scrollToModels = () => modelsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const openAllModels = () => {
        setAllModelsOpen(true);
        window.setTimeout(() => allModelsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    };

    // The device each installed model runs on (#88): its badge in the selects.
    const deviceFor = (model: InstalledModel) => deviceOf(model.provider, model.name, choice.devices);
    const modelLabel = (model: InstalledModel) => {
        const device = deviceFor(model);
        return (
            <span className="inline-flex items-center gap-2">
                {labelOf(model)}
                {device && <DeviceBadge device={device} />}
            </span>
        );
    };
    // The live list marks Parakeet as the one for live text.
    const liveHint = (model: InstalledModel) =>
        model.provider === 'parakeet' && model.name === choice.pair.live.id
            ? `${deviceFor(model) === 'Intel NPU' ? 'Light on power · ' : ''}recommended for live text`
            : undefined;

    const modelItems = (missing?: { key: string; label: string }, hint?: (model: InstalledModel) => string | undefined) => (
        <>
            {installedModels.map((model) => (
                <SelectItem key={keyOf(model.provider, model.name)} value={keyOf(model.provider, model.name)} hint={hint?.(model)}>
                    {modelLabel(model)}
                </SelectItem>
            ))}
            {missing && (
                <SelectItem value={missing.key} disabled>
                    {missing.label} (not installed)
                </SelectItem>
            )}
        </>
    );

    // A Labs speech option that is on is named on the step whose engine it
    // changes. The Parakeet GPU option does nothing while the Intel NPU runs
    // Parakeet or gets ready to (#66), so it is not named then.
    const labsBadge = (engine: SpeechEngine) =>
        engine === 'parakeet'
            ? labs.parakeetGpu && !npuOwnsParakeet(choice.npu) && <Badge variant="accent" size="xs" className="ml-1.5 align-middle">GPU · Labs</Badge>
            : labs.whisperSilenceGuard && <Badge variant="accent" size="xs" className="ml-1.5 align-middle">Silence guard · Labs</Badge>;

    const engineNote = (model: InstalledModel) => model.provider === 'parakeet' ? (
        <RowNote>
            <span>
                {`Fast and light on your computer. Recognizes ${speechModelLanguages(model.languages)?.toLowerCase() ?? 'European languages'} and detects which one is spoken.`}
            </span>
            {labsBadge('parakeet')}
        </RowNote>
    ) : (
        <RowNote>
            <span>
                Slower and heavier while recording; on a slower computer the live text can fall behind. Recognizes about 100 languages.
            </span>
            {labsBadge('whisper')}
        </RowNote>
    );

    // A failed switch of the optional Whisper job (the regular copy, N7):
    // the model is on disk, After the meeting could not be set to it.
    const whisperActivationFailed = whisperJob.status === 'activation-error'
        && !(postCallConfig.provider === 'whisper' && postCallConfig.model === OPTIONAL_WHISPER_MODEL);
    const whisperOffer = whisperActivationFailed ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-af-danger/30 bg-af-danger/[0.06] px-3.5 py-3">
            <p role="alert" className="min-w-0 flex-1 basis-60 text-xs text-af-danger [overflow-wrap:anywhere]">
                {`${`Whisper ${choice.whisper.find((model) => model.name === OPTIONAL_WHISPER_MODEL)?.display_name ?? ''}`.trim()} downloaded, but Protocol could not switch to it. `}
                {whisperJob.error}
            </p>
            {/* Native code finds the model on disk and only retries the switch. */}
            <Button variant="secondary" size="sm" onClick={() => startDownload('whisper')}>Retry</Button>
        </div>
    ) : null;

    const speechGroup = (
        <SettingsGroup title="Speech to text" key="speech">
            <SettingRow
                icon={Radio}
                title="During the meeting"
                description="Writes the live transcript while you record."
                control={
                    <Select value={installedModels.length === 0 ? '' : liveKey} onValueChange={chooseLive} disabled={isSavingLive || installedModels.length === 0} name="live-model">
                        <SelectTrigger className="w-80 max-w-full" aria-label="Model during the meeting">
                            <SelectValue placeholder={installedLoaded ? 'No speech model installed' : 'Loading…'} />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectGroup>
                                <SelectLabel>On this computer</SelectLabel>
                                {modelItems(liveEngine && liveKey && !liveModel ? { key: liveKey, label: missingLabel(liveEngine, transcriptModelConfig.model) } : undefined, liveHint)}
                            </SelectGroup>
                            <SelectGroup>
                                <SelectLabel>Not downloaded</SelectLabel>
                                <SelectItem value={ALL_MODELS} hint="In Speech models › All models">
                                    <span className="text-af-text-3">Whisper Small, Medium and others</span>
                                </SelectItem>
                            </SelectGroup>
                        </SelectContent>
                    </Select>
                }
            >
                {installedLoaded && installedModels.length === 0 ? (
                    <RowNote tone="warning" icon={AlertTriangle}>
                        No speech model is on this computer yet, so recording can&apos;t start.{' '}
                        <button type="button" onClick={scrollToModels} className="font-medium underline underline-offset-2">Download Parakeet</button>
                    </RowNote>
                ) : liveModel ? (
                    engineNote(liveModel)
                ) : installedLoaded ? (
                    <RowNote tone="warning" icon={AlertTriangle}>
                        The chosen model is not on this computer. Choose another one, or download it again under Speech models.
                    </RowNote>
                ) : null}
            </SettingRow>

            <SettingRow
                ref={afterMeetingRef}
                icon={AudioLines}
                title="After the meeting"
                description="When a recording is saved, Protocol transcribes it again in full for a cleaner transcript. To redo one meeting, use Enhance transcript in its ··· menu."
                control={
                    <Select value={afterKey} onValueChange={chooseAfter} disabled={isLoadingPostCall || isSavingPostCall || installedModels.length === 0} name="after-meeting-model">
                        <SelectTrigger className="w-80 max-w-full" aria-label="Model after the meeting">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="live">Same as during the meeting</SelectItem>
                            {modelItems(!followsLive && !afterExact ? { key: afterKey, label: missingLabel(postCallConfig.provider as SpeechEngine, postCallConfig.model) } : undefined)}
                        </SelectContent>
                    </Select>
                }
            >
                <div className="space-y-2.5">
                    {postCallError ? (
                        <RowNote tone="danger" icon={AlertTriangle}>{postCallError}</RowNote>
                    ) : postCallSaved ? (
                        <RowNote tone="success" icon={Check}>Saved</RowNote>
                    ) : !isLoadingPostCall && installedLoaded && installedModels.length > 0 ? (
                        !afterModel ? (
                            <RowNote tone="danger" icon={AlertTriangle}>
                                {`No ${afterEngine === 'whisper' ? 'Whisper' : 'speech'} model is installed, so transcripts can't be improved after meetings. Choose another model.`}
                            </RowNote>
                        ) : !afterExact && !followsLive ? (
                            <RowNote tone="warning" icon={AlertTriangle}>
                                {`${missingLabel(postCallConfig.provider as SpeechEngine, postCallConfig.model)} is not on this computer, so ${labelOf(afterModel)} is used instead.`}
                            </RowNote>
                        ) : followsLive ? (
                            <RowNote>
                                <span>{`Uses ${labelOf(afterModel)}.`}</span>
                                {labsBadge(afterModel.provider)}
                            </RowNote>
                        ) : labsBadge(afterModel.provider) ? (
                            <RowNote>{labsBadge(afterModel.provider)}</RowNote>
                        ) : null
                    ) : null}
                    {whisperOffer}
                </div>
            </SettingRow>

            {language && (
                <SettingRow
                    icon={Globe}
                    title="Meeting language"
                    description="The language people speak. Choosing it helps Whisper; Parakeet always detects the language itself."
                    control={
                        <Select value={language.value} onValueChange={language.onChange} disabled={language.disabled} name="meeting-language">
                            <SelectTrigger className="w-80 max-w-full" aria-label="Meeting language">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {LANGUAGES.map((entry) => (
                                    <SelectItem key={entry.code} value={entry.code}>
                                        {AUTO_LANGUAGE_NAMES[entry.code] ?? entry.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    }
                >
                    {language.disabled ? (
                        <RowNote>The language can&apos;t change while a recording is running.</RowNote>
                    ) : !usesWhisper && installedLoaded ? (
                        <RowNote>Your models detect the language themselves, so this applies only when Whisper transcribes.</RowNote>
                    ) : null}
                </SettingRow>
            )}

            <SettingRow
                icon={Zap}
                title="Faster live text"
                description="Shows words sooner by cutting speech into shorter pieces (up to 3.5 s instead of 6 s). Shorter pieces can split one person into extra speakers."
                control={<Switch checked={realTimeTranscription} onCheckedChange={handleToggleRealTime} aria-label="Faster live text" />}
            />
        </SettingsGroup>
    );

    const vocabularyDirty = vocabulary !== savedVocabulary;
    const vocabularyGroup = (
        <SettingsGroup title="Vocabulary" key="vocabulary">
            <SettingRow
                icon={BookOpen}
                title="Words to recognize"
                htmlFor="transcription-vocabulary"
                description="Names, companies, products and acronyms that should be spelled exactly, one per line. Used during and after meetings. Whisper reads only the start of a long list, so put the most important words first."
            >
                <Textarea
                    id="transcription-vocabulary"
                    value={vocabulary}
                    onChange={(event) => {
                        vocabularyRevisionRef.current += 1;
                        setVocabulary(event.target.value);
                        setVocabularySaved(false);
                        setVocabularyError(null);
                    }}
                    maxLength={1000}
                    rows={5}
                    disabled={isSavingVocabulary}
                    placeholder={'Protocol\nTauri\nKubernetes\nOKR'}
                    className="resize-y"
                />
                <div className="mt-2 flex items-center justify-between gap-3">
                    <div className="min-h-5 text-xs">
                        {vocabularyError ? (
                            <span className="text-af-danger">{vocabularyError}</span>
                        ) : vocabularySaved ? (
                            <span className="inline-flex items-center gap-1 text-af-success"><Check className="h-3.5 w-3.5" /> Saved</span>
                        ) : (
                            <span className="text-af-text-3 tabular-nums">
                                {vocabularyDirty ? 'Unsaved changes · ' : ''}{vocabulary.length}/1000 characters
                            </span>
                        )}
                    </div>
                    <Button type="button" size="sm" onClick={saveVocabulary} disabled={!vocabularyDirty} loading={isSavingVocabulary}>
                        Save
                    </Button>
                </div>
            </SettingRow>
        </SettingsGroup>
    );

    // The update offer (N2): this computer has an Intel GPU or NPU that
    // Protocol does not use yet. Not now hides it per device; the card keeps
    // a small way back to it while it still applies.
    const offerInputs = {
        installedAny: installedLoaded && installedModels.length > 0,
        availability: choice.availability,
        companion: choice.companion,
        npu: choice.npu,
    };
    const offer = choice.loaded && !switching ? offerFor({ ...offerInputs, dismissed }) : null;
    const putOff = choice.loaded && !switching && !offer ? offerFor({ ...offerInputs, dismissed: [] }) : null;
    const notNow = (devices: Device[]) => {
        writeDismissed(devices);
        setDismissed(devices);
    };
    const offerGroup = offer ? (
        <IntelOffer
            key="offer"
            offer={offer}
            companionId={choice.companion?.id ?? null}
            copy={choice.pair.copy}
            onNotNow={() => notNow(offer.devices)}
            onSwitch={() => { setSwitching(true); scrollToModels(); }}
        />
    ) : null;

    const modelsGroup = (
        <SettingsGroup
            key="models"
            ref={modelsRef}
            title="Speech models"
            description={installedLoaded && installedModels.length === 0
                ? "No speech model is on this computer yet, so recording can't start."
                : 'The models on this computer. A download keeps going while you use the rest of Protocol.'}
        >
            <div className={`px-5 py-4 ${isSavingLive || isSavingPostCall ? 'pointer-events-none opacity-70' : ''}`}>
                <ForThisComputer
                    choice={choice}
                    onParakeetInstalled={handleParakeetDownloaded}
                    onModelsChanged={() => void refreshInstalledModels()}
                    offerBack={putOff ? {
                        label: `${putOff.title.replace(/^Protocol can use your /, 'Use your ')}…`,
                        onClick: () => notNow([]),
                    } : null}
                />
            </div>
            <div ref={allModelsRef} className="scroll-mt-6">
                <button
                    type="button"
                    aria-expanded={allModelsOpen}
                    onClick={() => setAllModelsOpen((open) => !open)}
                    className="flex w-full items-center gap-2 px-5 py-3 text-left text-[13px] font-medium text-af-text-2 hover:text-af-text"
                >
                    <ChevronRight className={`h-3.5 w-3.5 transition-transform ${allModelsOpen ? 'rotate-90' : ''}`} aria-hidden />
                    All models
                </button>
                {allModelsOpen && (
                    <div className="divide-y divide-af-border border-t border-af-border">
                        <SettingRow title="Parakeet" description="Fast enough for live transcripts. Recommended while recording.">
                            <div className={isSavingLive ? 'pointer-events-none opacity-70' : ''}>
                                <ParakeetModelManager
                                    onModelSelect={handleParakeetDownloaded}
                                    onModelRemoved={() => { void refreshInstalledModels(); choice.refresh(); }}
                                    usageFor={usageFor('parakeet')}
                                    autoSave={false}
                                />
                            </div>
                        </SettingRow>
                        <SettingRow title="Whisper" description="Slower, but often more accurate on a full recording, and knows about 100 languages. Recommended after meetings.">
                            <div className={isSavingPostCall ? 'pointer-events-none opacity-70' : ''}>
                                <ModelManager
                                    onModelSelect={handleWhisperDownloaded}
                                    onModelRemoved={(name) => { void handleWhisperRemoved(name); choice.refresh(); }}
                                    removeModel={(name) => {
                                        // Native uninstall refuses during a recording and resets
                                        // every choice that used the model before deleting it.
                                        if (name !== OPTIONAL_WHISPER_MODEL) return false;
                                        uninstallModel('whisper');
                                        return true;
                                    }}
                                    startModelDownload={(name) => {
                                        // The same job as the card's: one download, and native
                                        // code makes it the after-meeting model even if Settings closes.
                                        if (name !== OPTIONAL_WHISPER_MODEL) return false;
                                        startDownload('whisper');
                                        return true;
                                    }}
                                    usageFor={usageFor('whisper')}
                                    autoSave={false}
                                />
                            </div>
                        </SettingRow>
                    </div>
                )}
            </div>
        </SettingsGroup>
    );

    // With nothing installed, downloading a model is the only thing to do
    // here, so the model lists come first. Keys keep each group mounted.
    const needsSetup = installedLoaded && installedModels.length === 0;
    const speakers = speakerSettings ? <Fragment key="speakers">{speakerSettings}</Fragment> : null;
    const groups = needsSetup
        ? [modelsGroup, speechGroup, vocabularyGroup, speakers]
        : [offerGroup, speechGroup, vocabularyGroup, speakers, modelsGroup];

    return <div className="space-y-8">{groups}</div>;
}
