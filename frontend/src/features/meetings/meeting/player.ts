import {useEffect, useState, useSyncExternalStore} from 'react'
import {useQuery} from '@tanstack/react-query'
import {audioSource, meetingAudioQuery} from '@/api/meetings'
import type {PlaybackClock} from '@/components/transcript/TranscriptList'

/** The speeds the speed button steps through, as the design draws them. */
export const PLAYBACK_RATES = [1, 1.25, 1.5, 2] as const

/** With Labs › Waveform scrubbing on: 0.5× and 0.75× before them. */
export const SLOW_PLAYBACK_RATES = [0.5, 0.75, ...PLAYBACK_RATES] as const

/** How far ← and → move while the scrubber has focus. */
export const SKIP_SECONDS = 5

export type PlayerStatus = 'loading' | 'ready' | 'unavailable' | 'error'

interface PlayerState {
    status: PlayerStatus
    playing: boolean
    duration: number
    rate: number
}

/**
 * One `<audio>` element for the meeting's recording, kept outside React.
 * The position is not state: `clock` hands it to listeners (the transcript's
 * highlight, the player's time and scrubber) on every frame while playing
 * and on each seek, so playback renders nothing. Play, pause, the length
 * and the speed are state, since the buttons show them.
 */
export class MeetingPlayer {
    readonly audio: HTMLAudioElement
    private state: PlayerState = {status: 'loading', playing: false, duration: 0, rate: 1}
    private stateListeners = new Set<() => void>()
    private positionListeners = new Set<(seconds: number) => void>()
    private frame = 0

    constructor() {
        this.audio = document.createElement('audio')
        this.audio.preload = 'metadata'
        const on = (name: string, run: () => void) => this.audio.addEventListener(name, run)
        on('loadedmetadata', () => this.set({status: 'ready', duration: Number.isFinite(this.audio.duration) ? this.audio.duration : 0}))
        on('durationchange', () => Number.isFinite(this.audio.duration) && this.set({duration: this.audio.duration}))
        on('error', () => this.audio.getAttribute('src') && this.set({status: 'error', playing: false}))
        on('play', () => {
            this.set({playing: true})
            this.tick()
        })
        on('pause', () => this.set({playing: false}))
        on('ended', () => this.set({playing: false}))
        on('ratechange', () => this.set({rate: this.audio.playbackRate}))
        on('seeked', () => this.publish())
        on('timeupdate', () => this.publish())
    }

    readonly clock: PlaybackClock = {
        subscribe: (listener) => {
            this.positionListeners.add(listener)
            listener(this.position)
            return () => void this.positionListeners.delete(listener)
        },
    }

    get position(): number {
        return this.audio.currentTime || 0
    }

    getState = () => this.state

    subscribeState = (listener: () => void) => {
        this.stateListeners.add(listener)
        return () => void this.stateListeners.delete(listener)
    }

    /** Points the player at a recording, or at none (`null`: nothing was saved). */
    load(source: string | null) {
        this.audio.pause()
        if (source === null) {
            this.audio.removeAttribute('src')
            this.set({status: 'unavailable', playing: false, duration: 0})
            return
        }
        if (this.audio.getAttribute('src') === source) return
        this.set({status: 'loading', playing: false, duration: 0})
        this.audio.src = source
        this.audio.load()
    }

    play() {
        if (this.state.status !== 'ready') return
        this.audio.play()?.catch(() => this.set({playing: false}))
    }

    pause() {
        this.audio.pause()
    }

    toggle = () => {
        if (this.audio.paused) this.play()
        else this.pause()
    }

    seek = (seconds: number) => {
        const end = this.state.duration || Number.POSITIVE_INFINITY
        this.audio.currentTime = Math.min(Math.max(0, seconds), end)
        this.publish()
    }

    skip = (delta: number) => this.seek(this.position + delta)

    /** Plays from a moment, as a transcript time or an action item does. */
    playFrom = (seconds: number) => {
        this.seek(seconds)
        this.play()
    }

    /** The speed after this one; a speed the list lacks (0.5× once Labs is off) goes back to its first. */
    nextRate = (rates: readonly number[] = PLAYBACK_RATES) => {
        this.audio.playbackRate = rates[(rates.indexOf(this.state.rate) + 1) % rates.length]
    }

    dispose() {
        cancelAnimationFrame(this.frame)
        this.audio.pause()
        this.audio.removeAttribute('src')
        this.audio.load()
    }

    private set(patch: Partial<PlayerState>) {
        this.state = {...this.state, ...patch}
        this.stateListeners.forEach((listener) => listener())
    }

    private publish() {
        const seconds = this.position
        this.positionListeners.forEach((listener) => listener(seconds))
    }

    // timeupdate fires about four times a second; frames keep the scrubber smooth.
    private tick = () => {
        cancelAnimationFrame(this.frame)
        if (this.audio.paused) return
        this.publish()
        this.frame = requestAnimationFrame(this.tick)
    }
}

/** The meeting's player, loaded with its recording once native says where it is. */
export function useMeetingPlayer(meetingId: string): { player: MeetingPlayer, state: PlayerState } {
    const [player] = useState(() => new MeetingPlayer())
    const audio = useQuery(meetingAudioQuery(meetingId))
    const path = audio.data?.path
    const failed = audio.isError

    useEffect(() => {
        if (failed) player.load(null)
        else if (path !== undefined) player.load(path ? audioSource(path) : null)
    }, [player, path, failed])

    useEffect(() => () => player.dispose(), [player])

    const state = useSyncExternalStore(player.subscribeState, player.getState)
    return {player, state}
}
