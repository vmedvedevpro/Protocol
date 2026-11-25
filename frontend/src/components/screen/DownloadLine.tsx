import {DownloadSimpleIcon} from '@phosphor-icons/react'
import {useQuery} from '@tanstack/react-query'
import {useNavigate} from 'react-router-dom'
import styled from 'styled-components'
import {catalogStatusQuery} from '@/api/modelCatalog'
import {
    builtInModelsQuery,
    type DownloadState,
    downloadsQuery,
    speechModelLabel,
    whisperModelsQuery,
} from '@/api/models'
import {ProgressBar} from '@/components/ui/ProgressBar'
import {StatusLine, type Status} from '@/components/ui/StatusLine'
import {colorTransition, keyboardRowRing} from '@/components/ui/styles'
import {paths} from '@/lib/paths'

const Button = styled.button`
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[2]};
    width: 100%;
    padding: ${({theme}) => theme.space[2]} ${({theme}) => theme.space[4]};
    border: 0;
    background: transparent;
    color: ${({theme}) => theme.colors.muted};
    font: inherit;
    text-align: left;
    cursor: pointer;
    ${colorTransition};

    &:hover {
        background: ${({theme}) => theme.colors.surface};
    }

    /* A full-width row of the footer: the inset ring of a list row. */
    &:focus-visible {
        ${keyboardRowRing};
    }

    > svg {
        flex: none;
    }
`

const Text = styled.span`
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
`

const Bar = styled.span`
    flex: none;
    width: 72px;
`

interface Running {
    name: string
    state: DownloadState
}

/** What a download is called on the line, from its key and the lists that name it. */
function useRunning(): Running[] {
    const downloads = useQuery(downloadsQuery).data
    const catalog = useQuery({...catalogStatusQuery, retry: false}).data
    const keys = Object.keys(downloads).filter((key) => downloads[key].state !== 'failed')
    const whisper = useQuery({...whisperModelsQuery, enabled: keys.some((key) => key.startsWith('whisper:'))}).data
    const builtIn = useQuery({...builtInModelsQuery, enabled: keys.some((key) => key.startsWith('builtIn:'))}).data

    const running = keys.map((key): Running => {
        const [engine, model] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
        const listed = whisper?.find(({name}) => name === model)
        const name = engine === 'parakeet' ? 'Parakeet'
            : engine === 'whisper' ? (listed ? speechModelLabel('whisper', listed) : 'Whisper')
            : engine === 'builtIn' ? (builtIn?.find(({name: id}) => id === model)?.display_name ?? 'the summary model')
            : engine === 'nemotron' ? 'NVIDIA Nemotron'
            : engine === 'intelGpu' ? 'Whisper for the Intel GPU'
            : "Intel's libraries"
        return {name, state: downloads[key]}
    })
    const updates = (catalog?.operations ?? []).filter(({phase}) => phase === 'downloading')
    for (const update of updates) {
        running.push({
            name: `the ${update.id} update`,
            state: {state: 'downloading', progress: update.totalBytes > 0 ? (update.doneBytes / update.totalBytes) * 100 : 0},
        })
    }
    return running
}

/**
 * The footer's line while any model downloads (owner decision 2026-11-24,
 * in place of the old download panel): what downloads and how far, below
 * 100 % until native has verified it. A click opens Settings › Speech
 * models, where each download has its row, Cancel and Retry.
 */
export function DownloadLine() {
    const navigate = useNavigate()
    const running = useRunning()
    if (running.length === 0) return null

    const percents = running.flatMap(({state}) => (state.state === 'downloading' ? [Math.min(state.progress, 99)] : []))
    const percent = percents.length ? percents.reduce((sum, value) => sum + value, 0) / percents.length : null
    const [first] = running
    const activating = running.length === 1 && first.state.state === 'activating'
    const status: Status = activating
        ? {key: 'activating', text: `Turning on ${first.name}`, busy: true}
        : {
            key: running.length === 1 ? `one:${first.name}` : 'several',
            text: running.length === 1 ? `Downloading ${first.name}` : `Downloading ${running.length} models`,
            value: percent === null ? undefined : `${Math.floor(percent)}%`,
            busy: percent === null,
        }

    return (
        <Button type="button" onClick={() => void navigate(paths.settingsPage('speech-models'))}>
            <DownloadSimpleIcon size={14} aria-hidden/>
            <Text><StatusLine status={status}/></Text>
            {percent !== null && <Bar><ProgressBar label={status.text} value={percent}/></Bar>}
        </Button>
    )
}
