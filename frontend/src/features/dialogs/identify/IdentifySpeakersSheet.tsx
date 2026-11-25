import {type FormEvent, useState} from 'react'
import {useQuery} from '@tanstack/react-query'
import styled from 'styled-components'
import {activeEngine, diarizationStatusQuery} from '@/api/diarization'
import {Button} from '@/components/ui/Button'
import {SettingsRadioGroup, SettingsRadioRow} from '@/components/ui/SettingsRow'
import {Sheet, SheetClose} from '@/components/ui/Sheet'
import {closeDialog, type OpenedDialog, useDialog} from '@/lib/dialogs'

const FORM_ID = 'identify-speakers'

/** The counts offered, as the old dialog's quick picks were. */
const SPEAKER_COUNTS = [2, 3, 4, 5, 6, 8] as const

const AUTOMATIC = 'auto'

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
            // diarize_meeting replaces only the generated labels (Speaker N,
            // You, Guest): a named line keeps its name, which also goes to the
            // rest of that voice, and contact links are kept.
            description="Protocol listens to the recording again and replaces the “Speaker N” labels; names you gave, links to contacts, the text and its times stay."
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
                <SettingsRadioGroup title="Speakers" layout="grid" value={choice} onValueChange={setChoice}>
                    <SettingsRadioRow value={AUTOMATIC} label="Detect automatically"/>
                    {SPEAKER_COUNTS.map((count) => <SettingsRadioRow key={count} value={String(count)} label={`${count} speakers`}/>)}
                </SettingsRadioGroup>
            )}
        </form>
    )
}
