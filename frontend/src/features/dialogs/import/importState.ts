import {create} from 'zustand'
import type {AudioFileInfo, ImportProgress} from '@/api/audioImport'

/**
 * - `pick`: no file yet, or the last one was removed.
 * - `checking`: native reads the chosen or dropped file.
 * - `ready`: a file to import.
 * - `importing`: native runs it; `progress` is its last reading.
 * - `cancelling`: Stop was pressed; native ends at its next check.
 * - `failed`: the import, or the file's check, failed with `error`.
 */
export type ImportPhase =
    | { step: 'pick' | 'checking' | 'ready' | 'cancelling' }
    | { step: 'importing', progress: ImportProgress | null }
    | { step: 'failed', error: string }

interface ImportState {
    phase: ImportPhase
    /** The file to import, once native has checked it. */
    file: AudioFileInfo | null
    /** The meeting's title, the file's name until the user types one. */
    title: string
    /**
     * The folder chosen when Import was pressed; the sheet files the meeting
     * in it when native says the import is complete, whatever the form shows.
     */
    folder: { id: string, name: string } | null
}

/**
 * Where the import stands, outside the sheet's form: native runs the import
 * whatever the sheet shows, and the sheet's footer and its form both read
 * it. A drop onto the open sheet changes the file here.
 */
export const useImportState = create<ImportState>(() => ({phase: {step: 'pick'}, file: null, title: '', folder: null}))

export const isRunning = (phase: ImportPhase) => phase.step === 'importing' || phase.step === 'cancelling'

/** Back to an empty form; the sheet leaves a running import alone. */
export const resetImport = () => useImportState.setState({phase: {step: 'pick'}, file: null, title: '', folder: null})
