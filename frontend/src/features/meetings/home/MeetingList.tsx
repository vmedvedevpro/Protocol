import {type KeyboardEvent, memo, type ReactNode, useMemo, useState} from 'react'
import {Link} from 'react-router-dom'
import styled, {css} from 'styled-components'
import type {MeetingListItem} from '@/api/meetings'
import {usePostCallJob} from '@/api/postCall'
import {colorTransition, focusRing} from '@/components/ui/styles'
import {paths} from '@/lib/paths'
import {VeilRow} from '@/components/ui/Veil'
import {ProcessingLine} from '../components/processing/ProcessingLine'
import {dateGroup, formatLength, parseDate, rowWhen} from '@/lib/dates'

const Scroller = styled.div`
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: ${({theme}) => theme.space[1.5]} ${({theme}) => theme.space[2]} ${({theme}) => theme.space[2.5]};
`

// A group reads as one when the space before its heading is clearly more
// than the rhythm of its rows: two rows' text is 12 px apart (their padding).
// Before every heading after the first, 16 px and the heading's own 8 px
// make 24 px, twice that, while the heading stays 4 px from its own rows.
// (It was 14 px, which read as one more row gap.)
const Section = styled.section`
    & + & {
        margin-top: ${({theme}) => theme.space[4]};
    }
`

const Heading = styled.h2`
    margin: 0;
    padding: ${({theme}) => theme.space[2]} ${({theme}) => theme.space[2.5]} ${({theme}) => theme.space[1]};
    ${({theme}) => theme.text.small};
    font-weight: ${({theme}) => theme.fontWeights.semibold};
    color: ${({theme}) => theme.colors.muted};
`

const Rows = styled.ul`
    margin: 0;
    padding: 0;
    list-style: none;
`

const rowStyle = css`
    display: block;
`

const Row = styled.li`
    ${rowStyle};
`

const ArrivingRow = styled(VeilRow)`
    ${rowStyle};
`

// A meeting still being processed keeps the surface, as the design draws it.
const RowLink = styled(Link)<{ $busy: boolean }>`
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[3]};
    padding: ${({theme}) => theme.space[1.5]} ${({theme}) => theme.space[2.5]};
    border-radius: ${({theme}) => theme.radii.md};
    background: ${({theme, $busy}) => ($busy ? theme.colors.surface : 'transparent')};
    color: ${({theme}) => theme.colors.text};
    text-decoration: none;
    ${colorTransition};
    ${focusRing};

    &:hover {
        background: ${({theme}) => theme.colors.surface};
    }
`

const Main = styled.div`
    flex: 1;
    min-width: 0;
`

const Title = styled.span`
    display: block;
    overflow: hidden;
    ${({theme}) => theme.text.body};
    font-weight: ${({theme}) => theme.fontWeights.medium};
    white-space: nowrap;
    text-overflow: ellipsis;
`

const Line = styled.span`
    display: block;
    overflow: hidden;
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
    white-space: nowrap;
    text-overflow: ellipsis;
`

const Side = styled.span`
    display: flex;
    flex: none;
    flex-direction: column;
    align-items: flex-end;
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
    font-variant-numeric: tabular-nums;
`

interface MeetingRowProps {
    meeting: MeetingListItem
    folderName?: string
    arriving: boolean
    onRename: (meeting: MeetingListItem) => void
}

const MeetingRow = memo(function MeetingRow({meeting, folderName, arriving, onRename}: MeetingRowProps) {
    const job = usePostCallJob(meeting.id)
    const date = parseDate(meeting.created_at)
    const onKeyDown = (event: KeyboardEvent) => {
        if (event.key !== 'F2') return
        event.preventDefault()
        onRename(meeting)
    }
    const content = (
        <RowLink to={paths.meeting(meeting.id)} $busy={!!job} onKeyDown={onKeyDown}>
            <Main>
                <Title>{meeting.title}</Title>
                {job ? <Line><ProcessingLine meetingId={meeting.id}/></Line> : folderName && <Line>{folderName}</Line>}
            </Main>
            <Side>
                {date && <span>{rowWhen(date)}</span>}
                {meeting.duration_seconds ? <span>{formatLength(meeting.duration_seconds)}</span> : null}
            </Side>
        </RowLink>
    )
    return arriving
        ? <ArrivingRow>{content}</ArrivingRow>
        : <Row>{content}</Row>
})

interface MeetingListProps {
    /** Every meeting, newest first. */
    meetings: readonly MeetingListItem[]
    /** Which of them the list shows (the folder and the search). */
    shows: (meeting: MeetingListItem) => boolean
    /** Folder names by id, for a row's second line. */
    folderNames: ReadonlyMap<string, string>
    onRename: (meeting: MeetingListItem) => void
    /** Shown instead of the sections while no meeting matches. */
    empty: ReactNode
}

/**
 * The meetings, newest first, in sections by date (Today, Yesterday, This
 * week, Earlier this month, then by month). A row opens its meeting; F2
 * renames it. Its second line is the post-call pass while one runs, else
 * its folder. A meeting that arrives while the list is open (a recording
 * just saved) fades in; filtering shows and hides rows at once.
 */
export function MeetingList({meetings, shows, folderNames, onRename, empty}: MeetingListProps) {
    const shown = useMemo(() => meetings.filter(shows), [meetings, shows])
    const sections = useMemo(() => {
        const now = new Date()
        const grouped: { label: string, meetings: MeetingListItem[] }[] = []
        for (const meeting of shown) {
            const date = parseDate(meeting.created_at)
            const label = date ? dateGroup(date, now) : 'Undated'
            const last = grouped.at(-1)
            if (last?.label === label) last.meetings.push(meeting)
            else grouped.push({label, meetings: [meeting]})
        }
        return grouped
    }, [shown])

    // Meetings there at the first render arrive with the screen, whichever
    // folder shows; only one added later fades in.
    const [initialIds] = useState(() => new Set(meetings.map((meeting) => meeting.id)))

    return (
        <Scroller>
            {shown.length === 0 ? empty : sections.map((section) => (
                <Section key={section.label} aria-label={section.label}>
                    <Heading>{section.label}</Heading>
                    <Rows>
                        {section.meetings.map((meeting) => (
                            <MeetingRow
                                key={meeting.id}
                                meeting={meeting}
                                folderName={meeting.group_id ? folderNames.get(meeting.group_id) : undefined}
                                arriving={!initialIds.has(meeting.id)}
                                onRename={onRename}
                            />
                        ))}
                    </Rows>
                </Section>
            ))}
        </Scroller>
    )
}
