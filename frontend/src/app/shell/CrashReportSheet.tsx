import {useState} from 'react'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'
import {CaretRightIcon, FileZipIcon, PaperPlaneTiltIcon} from '@phosphor-icons/react'
import {AnimatePresence} from 'motion/react'
import * as m from 'motion/react-m'
import styled from 'styled-components'
import {
    chooseCrashReportDestination,
    createCrashReportZip,
    crashReportKeys,
    dismissPendingCrashReport,
    openCrashReportIssue,
    type PendingCrashReport,
    pendingCrashReportQuery,
} from '@/api/crashReport'
import {Button} from '@/components/ui/Button'
import {Sheet} from '@/components/ui/Sheet'
import {focusRing} from '@/components/ui/styles'
import {MOTION_OK, tween} from '@/styles/motion'

type CrashAction = 'send' | 'save' | 'ignore'

const FAILED: Record<CrashAction, string> = {
    send: "Couldn't prepare the crash report.",
    save: "Couldn't save the crash report.",
    ignore: "Couldn't dismiss the crash report.",
}

const PENDING: Record<CrashAction, string> = {
    send: 'Preparing…',
    save: 'Saving…',
    ignore: 'Ignoring…',
}

/**
 * Save asks where to put the ZIP; Send does the same, then opens a GitHub
 * issue to attach it to. Either ends by dismissing the report, as Ignore
 * does. `false` when the user cancelled the save dialog.
 */
async function resolveReport(action: CrashAction, report: PendingCrashReport): Promise<boolean> {
    if (action !== 'ignore') {
        const destination = await chooseCrashReportDestination(report)
        if (!destination) return false
        await createCrashReportZip(destination)
        if (action === 'send') await openCrashReportIssue()
    }
    try {
        await dismissPendingCrashReport()
    } catch (error) {
        // The ZIP is saved and the user has decided; the next launch may ask again.
        console.warn('Failed to dismiss the crash report:', error)
    }
    return true
}

function describeCrash(report: PendingCrashReport): string {
    const what = report.crashType === 'panic'
        ? 'Protocol encountered an internal error during the previous session.'
        : 'Protocol did not shut down cleanly during the previous session.'
    return `${what} Creating or ignoring this report does not include or modify meeting content.`
}

function formatDetected(detectedAt: string): string {
    const date = new Date(detectedAt)
    return Number.isNaN(date.getTime()) ? 'The previous session' : date.toLocaleString()
}

const Facts = styled.dl`
    display: grid;
    grid-template-columns: auto 1fr;
    gap: ${({theme}) => theme.space[1.5]} ${({theme}) => theme.space[4]};
    margin: 0;
    padding: ${({theme}) => theme.space[2.5]} ${({theme}) => theme.space[3]};
    border-radius: ${({theme}) => theme.radii.md};
    background: ${({theme}) => theme.colors.surface};

    dt {
        color: ${({theme}) => theme.colors.muted};
    }

    dd {
        margin: 0;
        text-align: right;
    }
`

const Version = styled.dd`
    font-family: ${({theme}) => theme.fonts.mono};
`

const Disclosure = styled.button`
    display: inline-flex;
    align-items: center;
    gap: ${({theme}) => theme.space[1]};
    margin-top: ${({theme}) => theme.space[3]};
    padding: 0;
    border: 0;
    border-radius: ${({theme}) => theme.radii.xs};
    background: none;
    ${({theme}) => theme.text.label};
    color: ${({theme}) => theme.colors.soft};
    cursor: pointer;
    ${focusRing};

    svg {
        transition: transform ${({theme}) => theme.motion.duration.fast} ${({theme}) => theme.motion.easing.standard};
    }

    ${MOTION_OK} {
        &[aria-expanded='true'] svg {
            transform: rotate(90deg);
        }
    }
`

const Small = styled.p`
    margin-top: ${({theme}) => theme.space[2]};
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

const Included = styled(m.div)`
    display: flex;
    flex-direction: column;
`

const Failure = styled.p`
    margin-top: ${({theme}) => theme.space[3]};
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.text};
    font-weight: ${({theme}) => theme.fontWeights.medium};
`

/**
 * The crash report a previous session left, offered once first launch is
 * done, as the old app did. Closing the sheet without a choice leaves the
 * report for the next launch.
 */
export function CrashReportSheet() {
    const queryClient = useQueryClient()
    const {data} = useQuery(pendingCrashReportQuery)
    // Held after the query empties, so the sheet stays mounted to play its exit.
    const [report, setReport] = useState<PendingCrashReport | null>(null)
    if (data && data !== report) setReport(data)
    const [open, setOpen] = useState(true)
    const [showIncluded, setShowIncluded] = useState(false)

    const resolve = useMutation({
        mutationFn: async (action: CrashAction) => report !== null && resolveReport(action, report),
        onSuccess: (resolved) => {
            if (!resolved) return
            setOpen(false)
            void queryClient.invalidateQueries({queryKey: crashReportKeys.all})
        },
        onError: (error) => console.error('Crash report action failed:', error),
    })
    const busy = resolve.isPending
    const label = (action: CrashAction, idle: string) => (busy && resolve.variables === action ? PENDING[action] : idle)

    if (!report) return null

    return (
        <Sheet
            open={open}
            // Not in the middle of a save: the dialog and the ZIP belong to it.
            onOpenChange={(next) => !busy && setOpen(next)}
            title="Protocol encountered a problem"
            description={describeCrash(report)}
            footer={(
                <>
                    <Button variant="ghost" disabled={busy} onClick={() => resolve.mutate('ignore')}>
                        {label('ignore', 'Ignore')}
                    </Button>
                    <Button disabled={busy} onClick={() => resolve.mutate('save')}>
                        <FileZipIcon aria-hidden/>
                        {label('save', 'Save ZIP')}
                    </Button>
                    <Button variant="filled" disabled={busy} onClick={() => resolve.mutate('send')}>
                        <PaperPlaneTiltIcon aria-hidden/>
                        {label('send', 'Send Report')}
                    </Button>
                </>
            )}
        >
            <Facts>
                <dt>Detected</dt>
                <dd>{formatDetected(report.detectedAt)}</dd>
                <dt>Version</dt>
                <Version>{report.appVersion}</Version>
            </Facts>

            <Disclosure
                type="button"
                aria-expanded={showIncluded}
                onClick={() => setShowIncluded(!showIncluded)}
            >
                <CaretRightIcon size={12} aria-hidden/>
                What&apos;s included?
            </Disclosure>
            <AnimatePresence initial={false}>
                {showIncluded && (
                    <Included
                        initial={{opacity: 0, y: -4}}
                        animate={{opacity: 1, y: 0}}
                        exit={{opacity: 0}}
                        transition={tween('fast')}
                    >
                        <Small>
                            Crash time and type, Protocol version, coarse operating-system details, bucketed CPU core
                            count, rounded memory size, acceleration backend, and source-relative panic file/line
                            details with a location fingerprint when available.
                        </Small>
                        <Small>
                            No audio, recordings, transcripts, summaries, meeting names, database, settings,
                            credentials, usernames, hostnames, or device names.
                        </Small>
                    </Included>
                )}
            </AnimatePresence>

            <Small>
                Send Report asks where to save the private ZIP, then opens a public GitHub issue. Opening GitHub
                contacts GitHub; the ZIP stays local until you choose it as an attachment, which uploads it before
                issue submission.
            </Small>

            {resolve.isError && <Failure role="alert">{FAILED[resolve.variables]}</Failure>}
        </Sheet>
    )
}
