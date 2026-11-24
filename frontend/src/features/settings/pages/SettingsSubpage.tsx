import {CaretLeftIcon} from '@phosphor-icons/react'
import {Navigate, useNavigate, useParams} from 'react-router-dom'
import styled from 'styled-components'
import {Screen} from '@/app/shell/Screen'
import {Button} from '@/components/ui/Button'
import {paths} from '@/lib/paths'
import type {SettingsSection} from '../sections'
import {SETTINGS_SECTIONS} from '../sections'
import {useAdvancedSettingsStore} from '../store/advanced'

/** The pages inside Settings: their titles and the section each belongs to. */
const PAGES = {
    'summary-model': {title: 'Summary model', section: 'ai'},
    'chosen-apps': {title: 'Chosen apps', section: 'recording'},
} as const satisfies Record<Parameters<typeof paths.settingsPage>[0], {title: string; section: SettingsSection}>

// Own keys only: `in` would also take `constructor` and its kind.
const isPage = (page: string | undefined): page is keyof typeof PAGES => page !== undefined && Object.hasOwn(PAGES, page)

const Head = styled.div`
    display: flex;
    flex: none;
    flex-direction: column;
    align-items: flex-start;
    gap: ${({theme}) => theme.space[1]};
    padding: 0 ${({theme}) => theme.space[4]} ${({theme}) => theme.space[2.5]} ${({theme}) => theme.space[2]};
`

const Title = styled.h1`
    padding-left: ${({theme}) => theme.space[2]};
    ${({theme}) => theme.text.screen};
`

const Body = styled.div`
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: ${({theme}) => theme.space[3]} ${({theme}) => theme.space[4]};
    border-top: 1px solid ${({theme}) => theme.colors.border};
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

/**
 * A page inside Settings, such as the summary model's. Back returns where
 * it was opened from: the simple page, or the page's section when Advanced
 * is on. #117 builds the pages; until then each says so.
 */
export function SettingsSubpage() {
    const {page} = useParams()
    const navigate = useNavigate()
    const advanced = useAdvancedSettingsStore((state) => state.advanced)
    if (!isPage(page)) return <Navigate to={paths.settings()} replace/>

    const {title, section} = PAGES[page]
    const parent = advanced ? SETTINGS_SECTIONS.find((option) => option.value === section)?.label ?? 'Settings' : 'Settings'
    const back = () => void navigate(advanced ? paths.settings(section) : paths.settings())

    return (
        <Screen>
            <Head>
                <Button variant="ghost" size="sm" aria-label={`Back to ${parent}`} onClick={back}>
                    <CaretLeftIcon size={13} aria-hidden/>
                    {parent}
                </Button>
                <Title>{title}</Title>
            </Head>
            <Body>This page arrives with #117.</Body>
        </Screen>
    )
}
