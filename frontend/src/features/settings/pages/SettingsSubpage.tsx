import {CaretLeftIcon} from '@phosphor-icons/react'
import {Navigate, useNavigate, useParams} from 'react-router-dom'
import styled from 'styled-components'
import {Screen} from '@/components/screen/Screen'
import {Button} from '@/components/ui/Button'
import {paths} from '@/lib/paths'
import {SETTINGS_SECTIONS} from '../sections'
import {useAdvancedSettingsStore} from '../store/advanced'
import {isSettingsPage, SETTINGS_PAGES} from './settingsPages'

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

/**
 * A page inside Settings, such as the summary model's. Back returns where
 * it was opened from: the simple page, or the page's section when Advanced
 * is on. Each page draws its own body (`SETTINGS_PAGES`).
 */
export function SettingsSubpage() {
    const {page} = useParams()
    const navigate = useNavigate()
    const advanced = useAdvancedSettingsStore((state) => state.advanced)
    if (!isSettingsPage(page)) return <Navigate to={paths.settings()} replace/>

    const {title, section, Page} = SETTINGS_PAGES[page]
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
            <Page back={back}/>
        </Screen>
    )
}
