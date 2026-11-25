import {type FormEvent, useState} from 'react'
import {XIcon} from '@phosphor-icons/react'
import {useMutation, useQuery} from '@tanstack/react-query'
import {AnimatePresence} from 'motion/react'
import styled from 'styled-components'
import {errorMessage} from '@/api/core'
import {MAX_VOCABULARY_CHARS, saveGlobalVocabularyMutation, vocabularyQuery} from '@/api/speech'
import {Button} from '@/components/ui/Button'
import {SettingsGroup, SettingsRow} from '@/components/ui/SettingsRow'
import {TextField} from '@/components/ui/TextField'
import {toast} from '@/components/ui/toastStore'
import {Veil} from '@/components/ui/Veil'
import {Chip, chipMotion, ChipButton, Chips, Warning} from '../styles'
import {addToVocabulary, formatVocabulary, parseVocabulary, removeFromVocabulary} from './vocabulary'

const AddLine = styled.form`
    display: flex;
    gap: ${({theme}) => theme.space[1.5]};

    > :first-child {
        flex: 1;
        min-width: 0;
    }
`

/**
 * Words to recognize: names, products and jargon the models are told to
 * expect in every meeting, as entries added one at a time and removed by
 * their chip. Each change saves at once, as the other settings do.
 */
export function VocabularyGroup() {
    const saved = useQuery(vocabularyQuery())
    const save = useMutation(saveGlobalVocabularyMutation())
    const [typed, setTyped] = useState('')
    const [full, setFull] = useState(false)
    // While a save runs, the list it sends: a second change builds on the first.
    const terms = parseVocabulary(save.isPending ? save.variables : saved.data?.global ?? '')

    const store = (next: string[]) => save.mutate(formatVocabulary(next), {
        onError: (error) => toast.error('Couldn’t save the words', {description: errorMessage(error)}),
    })
    const add = (event: FormEvent) => {
        event.preventDefault()
        const next = addToVocabulary(terms, typed)
        setFull(next === 'full')
        if (next === 'full') return
        setTyped('')
        if (next.length !== terms.length) store(next)
    }

    return (
        <SettingsGroup title="Vocabulary">
            <SettingsRow label="Words to recognize">
                <AddLine onSubmit={add}>
                    {/* Named by the row's label, so the label is not said twice. */}
                    <TextField
                        size="sm"
                        value={typed}
                        placeholder="A name, product or term"
                        disabled={!saved.isSuccess}
                        onChange={(event) => setTyped(event.target.value)}
                    />
                    <Button size="sm" type="submit" disabled={!saved.isSuccess || !typed.trim()}>Add</Button>
                </AddLine>
                {full && <Warning role="alert">{`The list is full: ${MAX_VOCABULARY_CHARS} characters at most`}</Warning>}
                {terms.length > 0 && (
                    <Chips>
                        <AnimatePresence initial={false} mode="popLayout">
                            {terms.map((term) => (
                                <Chip key={term.toLowerCase()} {...chipMotion}>
                                    {term}
                                    <ChipButton
                                        type="button"
                                        aria-label={`Remove ${term}`}
                                        onClick={() => {
                                            setFull(false)
                                            store(removeFromVocabulary(terms, term))
                                        }}
                                    >
                                        <XIcon size={11} aria-hidden/>
                                    </ChipButton>
                                    <Veil duration="fast" outset={1}/>
                                </Chip>
                            ))}
                        </AnimatePresence>
                    </Chips>
                )}
            </SettingsRow>
        </SettingsGroup>
    )
}
