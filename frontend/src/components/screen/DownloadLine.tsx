import {DownloadSimpleIcon} from '@phosphor-icons/react'
import {useQuery} from '@tanstack/react-query'
import {useNavigate} from 'react-router-dom'
import styled from 'styled-components'
import {catalogStatusQuery} from '@/api/modelCatalog'
import {downloadLabel, type DownloadState, downloadsQuery} from '@/api/models'
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

/** What downloads now: the model downloads by their key's label, and the catalog's updates. */
function useRunning(): Running[] {
    const downloads = useQuery(downloadsQuery).data
    const catalog = useQuery({...catalogStatusQuery, retry: false}).data
    const running = Object.entries(downloads)
        .filter(([, state]) => state.state !== 'failed')
        .map(([key, state]): Running => ({name: downloadLabel(key), state}))
    for (const update of (catalog?.operations ?? []).filter(({phase}) => phase === 'downloading')) {
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
 * 100 % until native has verified it, or how many while several do. A click opens Settings › Speech
 * models, where each download has its row, Cancel and Retry.
 */
export function DownloadLine() {
    const navigate = useNavigate()
    const running = useRunning()
    if (running.length === 0) return null

    // One download shows its percent; several only that they run, since a
    // mean of their percents would go back when one more starts.
    const [first] = running
    const percent = running.length === 1 && first.state.state === 'downloading' ? Math.min(first.state.progress, 99) : null
    const status: Status = running.length > 1
        ? {key: 'several', text: `Downloading ${running.length} models`, busy: true}
        : percent === null
            ? {key: 'activating', text: `Turning on ${first.name}`, busy: true}
            : {key: `one:${first.name}`, text: `Downloading ${first.name}`, value: `${Math.floor(percent)}%`}

    return (
        <Button type="button" onClick={() => void navigate(paths.settingsPage('speech-models'))}>
            <DownloadSimpleIcon size={14} aria-hidden/>
            <Text><StatusLine status={status}/></Text>
            {percent !== null && <Bar><ProgressBar label={status.text} value={percent}/></Bar>}
        </Button>
    )
}
