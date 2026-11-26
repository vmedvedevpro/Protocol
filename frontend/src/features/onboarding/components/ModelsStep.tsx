import {useEffect, useRef} from 'react'
import styled from 'styled-components'
import type {Platform} from '@/lib/platform'
import type {DownloadRow} from '../hooks/useFirstLaunchDownloads'
import type {SummaryChoiceState} from '../hooks/useSummaryChoice'
import {DownloadList} from './DownloadList'
import {MeetingLanguageChoice} from './MeetingLanguageChoice'
import {MicCheck} from './MicCheck'
import {SummaryChoice} from './SummaryChoice'

const Body = styled.div`
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: ${({theme}) => theme.space[4]} ${({theme}) => theme.space[6]};
`

const Title = styled.h1`
    ${({theme}) => theme.text.title};

    &:focus {
        outline: none;
    }
`

const Lead = styled.p`
    ${({theme}) => theme.text.body};
    margin-top: ${({theme}) => theme.space[1.5]};
    color: ${({theme}) => theme.colors.muted};
`

interface ModelsStepProps {
    rows: DownloadRow[]
    summary: SummaryChoiceState
    /** The meeting language until Done saves it. */
    language: string
    onLanguage: (language: string) => void
    platform: Platform
    /** Coming from the name: Continue leaves with the name step, so focus goes to this heading. */
    focusOnMount: boolean
}

/**
 * Step 2: the speech downloads, running since first launch opened, the
 * meeting language, how summaries are written, and the microphone check.
 */
export function ModelsStep({rows, summary, language, onLanguage, platform, focusOnMount}: ModelsStepProps) {
    const title = useRef<HTMLHeadingElement>(null)

    useEffect(() => {
        if (focusOnMount) title.current?.focus({preventScroll: true})
    }, [focusOnMount])

    return (
        <Body>
            <Title ref={title} tabIndex={-1}>Get ready for the first meeting</Title>
            <Lead>Protocol needs two speech models. They download once.</Lead>
            <DownloadList rows={rows}/>
            <MeetingLanguageChoice value={language} onChange={onLanguage}/>
            <SummaryChoice choice={summary}/>
            <MicCheck platform={platform}/>
        </Body>
    )
}
