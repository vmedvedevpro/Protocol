import {useEffect, useState} from 'react'
import {CaretDownIcon} from '@phosphor-icons/react'
import styled from 'styled-components'
import {requestModelSizes} from '@/api/modelCatalog'
import {downloadKey} from '@/api/models'
import {Collapse} from '@/components/ui/Collapse'
import {SettingsGroup} from '@/components/ui/SettingsRow'
import {colorTransition} from '@/components/ui/styles'
import {formatModelSize} from '@/lib/sizes'
import {type SpeechModel, useModelUse, useSpeechModels} from '../../hooks/useSpeechModels'
import {Warning} from '../styles'
import {ForThisComputer} from './ForThisComputer'
import {ModelRow} from './ModelRow'
import {catalogLine, facts, languagesLine} from './modelText'

const Groups = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[5]};
`

const MoreButton = styled.button`
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[2]};
    width: 100%;
    padding: ${({theme}) => theme.space[2.5]} ${({theme}) => theme.space[3]};
    border: 0;
    background: transparent;
    color: ${({theme}) => theme.colors.text};
    font: inherit;
    ${({theme}) => theme.text.body};
    text-align: left;
    cursor: pointer;
    ${colorTransition};

    &:hover {
        background: ${({theme}) => theme.colors.raised};
    }

    &:focus-visible {
        outline: 2px solid ${({theme}) => theme.colors.text};
        outline-offset: -2px;
    }

    > span {
        flex: 1;
    }

    > svg {
        color: ${({theme}) => theme.colors.muted};
        transition: transform ${({theme}) => theme.motion.duration.fast} ${({theme}) => theme.motion.easing.standard};
    }

    &[aria-expanded='true'] > svg {
        transform: rotate(180deg);
    }
`

const Hint = styled.span`
    flex: none;
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

/** The list's own name: the group says the engine. */
const ownName = (model: SpeechModel) => (model.display_name || model.name).replace(/^(Parakeet|Whisper)\s+/i, '')

/**
 * Settings › Speech models: the pair for this computer, then every Parakeet
 * and Whisper model to download, update or remove. Whisper's list shows the
 * catalog's main sizes and what is installed or downloading; the rest is
 * under More models.
 */
export function SpeechModels() {
    const models = useSpeechModels()
    const usageOf = useModelUse()
    const [more, setMore] = useState(false)

    // Native reads the sizes a list lacks from Hugging Face; the lists are read again when they arrive.
    useEffect(() => {
        void requestModelSizes('parakeet').catch(() => undefined)
        void requestModelSizes('whisper').catch(() => undefined)
    }, [])

    const row = (model: SpeechModel) => (
        <ModelRow
            key={model.name}
            name={ownName(model)}
            engine={model.engine}
            model={model}
            use={usageOf(model.engine, model.name)}
            description={model.recommended
                ? (model.engine === 'parakeet' ? 'Recommended for live text' : 'Recommended after meetings')
                : facts(catalogLine(model.description), formatModelSize(model.size_bytes), languagesLine(model.languages))}
            downloads={models.downloads}
            onDownload={() => models.download(model)}
            onCancel={() => models.cancel(model)}
            onRemove={() => models.remove(model)}
            catalog={{engine: model.engine, id: model.name}}
        />
    )

    const busy = (model: SpeechModel) => model.status === 'Available' || !!models.downloads[downloadKey('whisper', model.name)]
    const main = models.whisper.filter((model) => model.recommended || model.tier === 'basic' || busy(model))
    const rest = models.whisper.filter((model) => !main.includes(model))

    if (models.failed) return <Warning role="alert">The speech models could not be read. Restart Protocol and try again.</Warning>
    return (
        <Groups>
            <ForThisComputer/>
            <SettingsGroup title="Parakeet">{models.parakeet.map(row)}</SettingsGroup>
            <SettingsGroup title="Whisper">
                {main.map(row)}
                {rest.length > 0 && (
                    <>
                        <MoreButton type="button" aria-expanded={more} onClick={() => setMore(!more)}>
                            <span>More models</span>
                            <Hint>Tiny and other sizes</Hint>
                            <CaretDownIcon size={13} aria-hidden/>
                        </MoreButton>
                        <Collapse open={more}>{rest.map(row)}</Collapse>
                    </>
                )}
            </SettingsGroup>
        </Groups>
    )
}
