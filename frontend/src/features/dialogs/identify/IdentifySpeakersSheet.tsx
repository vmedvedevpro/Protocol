import {type FormEvent, useState} from 'react'
import {useQuery} from '@tanstack/react-query'
import styled from 'styled-components'
import {activeEngine, diarizationStatusQuery} from '@/api/diarization'
import {Button} from '@/components/ui/Button'
import {Select} from '@/components/ui/Select'
import {SettingsGroup, SettingsRow} from '@/components/ui/SettingsRow'
import {Sheet, SheetClose} from '@/components/ui/Sheet'
import {closeDialog, type OpenedDialog, useDialog} from '@/lib/dialogs'

const FORM_ID = 'identify-speakers'

/** The counts offered, as the old dialog's quick picks were. */
const SPEAKER_COUNTS = [2, 3, 4, 5, 6, 8] as const

const AUTOMATIC = 'auto'

/** One dropdown on one row with its label (#205), Detect automatically first. */
const COUNT_OPTIONS = [
    {value: AUTOMATIC, label: 'Detect automatically'},
    ...SPEAKER_COUNTS.map((count) => ({value: String(count), label: `${count} speakers`})),
]

const Note = styled.p`
    margin: 0;
    ${({theme}) => theme.text.body};
    color: ${({theme}) => theme.colors.muted};
`

/**
 * Identify speakers, from the meeting's Transcript tab or its menu: how
 * many voices to look for, or detect them, and a confirm, so a meeting is
 * never relabelled by a stray pick. Identify hands the count to the
 * screen's run (`request.identify`) and closes; the screen shows it running.
 */
export function IdentifySpeakersSheet() {
    const slot = useDialog()
    const request = slot.request?.kind === 'identify-speakers' ? slot.request : null
    return (
        <Sheet
            open={slot.open && request !== null}
            onOpenChange={(next) => !next && closeDialog('identify-speakers')}
            title="Identify speakers"
            // diarize_meeting relabels every line from the new voices (#217):
            // a name goes to the voice it matches, a line moved by hand keeps
            // its label, and contact links are kept.
            description="Protocol listens to the recording again and labels the lines by voice. A name you gave stays with its voice, and a line you moved by hand keeps its speaker; the text and its times stay."
            footer={(
                <>
                    <SheetClose asChild><Button variant="ghost">Cancel</Button></SheetClose>
                    <Button variant="filled" type="submit" form={FORM_ID}>Identify</Button>
                </>
            )}
        >
            {request && <CountForm key={request.seq} request={request}/>}
        </Sheet>
    )
}

function CountForm({request}: { request: Extract<OpenedDialog, { kind: 'identify-speakers' }> }) {
    const [choice, setChoice] = useState<string>(AUTOMATIC)
    // diarize_meeting drops the count for Nemotron, so a count offered there
    // would be ignored; the engine is read where Settings sets it.
    const nemotron = activeEngine(useQuery(diarizationStatusQuery).data) === 'nemotron'
    const submit = (event: FormEvent) => {
        event.preventDefault()
        request.identify(nemotron || choice === AUTOMATIC ? null : Number(choice))
        closeDialog('identify-speakers')
    }
    return (
        <form id={FORM_ID} onSubmit={submit}>
            {nemotron ? (
                <Note>NVIDIA Nemotron, the speaker engine in Settings, finds the number of speakers itself.</Note>
            ) : (
                <SettingsGroup>
                    <SettingsRow
                        label="Speakers"
                        description={choice === AUTOMATIC ? undefined : 'The transcript shows exactly this many.'}
                        control={<Select options={COUNT_OPTIONS} value={choice} onValueChange={setChoice}/>}
                    />
                </SettingsGroup>
            )}
        </form>
    )
}
