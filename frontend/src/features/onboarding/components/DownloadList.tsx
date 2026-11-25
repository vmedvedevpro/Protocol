import {type ReactNode, useState} from 'react'
import {CpuIcon, FileTextIcon, TextAlignLeftIcon, WaveformIcon} from '@phosphor-icons/react'
import {AnimatePresence} from 'motion/react'
import * as m from 'motion/react-m'
import styled from 'styled-components'
import {errorMessage} from '@/api/core'
import {isAlreadyDownloading, isCancelledDownload} from '@/api/models'
import {Button} from '@/components/ui/Button'
import {ProgressBar} from '@/components/ui/ProgressBar'
import {Spinner} from '@/components/ui/Spinner'
import {toast} from '@/components/ui/toastStore'
import {Veil} from '@/components/ui/Veil'
import {withSize} from '@/lib/sizes'
import {statusSwap as swap, tween} from '@/styles/motion'
import type {DownloadRow, RowState} from '../hooks/useFirstLaunchDownloads'

const ICONS: Record<string, ReactNode> = {
    live: <WaveformIcon size={16}/>,
    npu: <CpuIcon size={16}/>,
    afterMeetings: <FileTextIcon size={16}/>,
    summaries: <TextAlignLeftIcon size={16}/>,
}

// The colour behind its rows' veils (Veil).
const List = styled.ul`
    --surface: ${({theme}) => theme.colors.surface};
    margin: ${({theme}) => theme.space[4]} 0 0;
    padding: 0;
    border-radius: ${({theme}) => theme.radii.xl};
    background: ${({theme}) => theme.colors.surface};
    list-style: none;
`

const Row = styled(m.li)`
    position: relative;
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[3]};
    padding: ${({theme}) => theme.space[3]};

    & + & {
        border-top: 1px solid ${({theme}) => theme.colors.border};
    }

    > svg {
        flex: none;
        color: ${({theme}) => theme.colors.muted};
    }
`

const Text = styled.div`
    flex: 1;
    min-width: 0;
`

const Title = styled.div`
    ${({theme}) => theme.text.body};
`

// Positioned for the veil of the failure's line.
const Detail = styled.div`
    position: relative;
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
    overflow-wrap: anywhere;
`

// As wide as the design's bar, so the percent and Ready line up down the list.
const Progress = styled.div`
    display: flex;
    flex: none;
    flex-direction: column;
    align-items: flex-end;
    gap: ${({theme}) => theme.space[1]};
    width: 96px;
`

const Label = styled(m.span)`
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: ${({theme}) => theme.space[1]};
    ${({theme}) => theme.text.caption};
    font-family: ${({theme}) => theme.fonts.mono};
    font-variant-numeric: tabular-nums;
    color: ${({theme}) => theme.colors.muted};
`

const Bar = styled.div`
    width: 100%;
`

function label(state: RowState) {
    switch (state.kind) {
        case 'ready': return 'Ready'
        case 'downloading': return `${state.progress}%`
        case 'activating': return 'Turning on'
        case 'queued': return 'Queued'
        case 'failed': return 'Failed'
        case 'missing': return '0%'
    }
}

function DownloadItem({row: {download, state}}: { row: DownloadRow }) {
    const [retrying, setRetrying] = useState(false)
    const [starting, setStarting] = useState(false)
    const {optional} = download

    const retry = () => {
        setRetrying(true)
        download.retry()
            .catch((error: unknown) => {
                if (isAlreadyDownloading(error) || isCancelledDownload(error)) return
                toast.error('Download retry failed', {description: errorMessage(error)})
            })
            .finally(() => setRetrying(false))
    }

    // Its progress and a failure come through downloadsQuery; the call itself
    // resolves only when the download ends, and a Cancel rejects it.
    const install = () => {
        setStarting(true)
        download.start().catch(() => undefined).finally(() => setStarting(false))
    }
    const cancel = () => {
        optional?.cancel().catch((error: unknown) => toast.error('Couldn’t cancel the download', {description: errorMessage(error)}))
    }

    // A percent ticks in place; the label swaps only when its meaning does.
    const meaning = state.kind === 'missing' ? 'downloading' : state.kind
    // Not started yet: Install stands where the progress will be.
    const offered = optional && state.kind === 'missing'
    return (
        <Row initial={{y: 4}} animate={{y: 0}} transition={tween('base', 'enter')}>
            {ICONS[download.id]}
            <Text>
                <Title>{download.title}</Title>
                <Detail>{download.detail}</Detail>
                <AnimatePresence initial={false}>
                    {state.kind === 'failed' && (
                        <Detail as={m.div} {...swap}>{state.error}<Veil duration="fast"/></Detail>
                    )}
                </AnimatePresence>
            </Text>
            {offered ? (
                <Button size="sm" pending={starting} onClick={install} aria-label={`Install ${download.title}`}>
                    {withSize('Install', optional.sizeBytes)}
                </Button>
            ) : (
            <Progress>
                <AnimatePresence mode="wait" initial={false}>
                    <Label key={meaning} {...swap}>
                        {/* Turning on has no percent: the spinner shows it still runs. */}
                        {state.kind === 'activating' && <Spinner/>}
                        {label(state)}
                        <Veil duration="fast"/>
                    </Label>
                </AnimatePresence>
                {state.kind === 'failed' ? (
                    <Button size="sm" pending={retrying} onClick={retry} aria-label={`Retry ${download.title}`}>
                        Retry
                    </Button>
                ) : (
                    <Bar>
                        <ProgressBar
                            label={download.title}
                            // Turning on follows the download: the bar stays full rather than falling to 0.
                            value={state.kind === 'ready' || state.kind === 'activating' ? 100 : state.kind === 'downloading' ? state.progress : 0}
                        />
                    </Bar>
                )}
            </Progress>
            )}
            {optional && state.kind === 'downloading' && (
                <Button size="sm" variant="ghost" onClick={cancel} aria-label={`Cancel downloading ${download.title}`}>Cancel</Button>
            )}
            <Veil/>
        </Row>
    )
}

/**
 * The models first launch downloads, each with how far it has got, and
 * Retry once it failed; an optional one offers Install with its size first,
 * and Cancel while it downloads.
 */
export function DownloadList({rows, label = 'Downloads'}: { rows: DownloadRow[], label?: string }) {
    return (
        <List aria-label={label}>
            {rows.map((row) => <DownloadItem key={row.download.id} row={row}/>)}
        </List>
    )
}
