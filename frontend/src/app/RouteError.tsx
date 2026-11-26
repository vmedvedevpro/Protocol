import {useEffect, useRef} from 'react'
import {isRouteErrorResponse, useNavigate, useRouteError} from 'react-router-dom'
import styled from 'styled-components'
import {errorMessage} from '@/api/core'
import {logWebViewError} from '@/api/logs'
import {Screen} from '@/components/screen/Screen'
import {Button} from '@/components/ui/Button'
import {TransparentWindow} from '@/features/recording/minibar/TransparentWindow'
import {paths} from '@/lib/paths'

const Centre = styled.div`
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: ${({theme}) => theme.space[2]};
    padding: ${({theme}) => theme.space[6]};
    text-align: center;
    outline: none;
`

const Title = styled.h1`
    ${({theme}) => theme.text.title};
`

const Text = styled.p`
    max-width: 40ch;
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.soft};
    overflow-wrap: anywhere;
`

const Actions = styled.div`
    display: flex;
    gap: ${({theme}) => theme.space[2]};
    margin-top: ${({theme}) => theme.space[2]};
`

// The minibar's window is the pill's height, transparent around it.
const MinibarWindow = styled.div`
    display: flex;
    align-items: center;
    height: 100%;
`

const Pill = styled.div`
    display: inline-flex;
    align-items: center;
    gap: ${({theme}) => theme.space[3]};
    height: ${({theme}) => theme.sizes.minibar.height};
    padding: 0 ${({theme}) => theme.space[1.5]} 0 ${({theme}) => theme.space[4]};
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.pill};
    background: ${({theme}) => theme.colors.raised};
    color: ${({theme}) => theme.colors.text};
    ${({theme}) => theme.text.small};
    white-space: nowrap;
`

const describe = (error: unknown) =>
    isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : errorMessage(error)

/** The error a route threw, written to the native log once. */
function useLoggedRouteError() {
    const error = useRouteError()
    useEffect(() => {
        logWebViewError('screen error', error)
    }, [error])
    return error
}

/**
 * A screen that threw while rendering: React Router's error boundary shows
 * this in its place and the error goes to the native log. Inside the shell
 * the title bar stays, so Settings › Advanced › Save logs is a click away.
 */
export function RouteError() {
    const error = useLoggedRouteError()
    const navigate = useNavigate()
    // Focus moves here, so a screen reader reads the alert and the keyboard
    // starts at its buttons rather than on a control that is gone.
    const alert = useRef<HTMLDivElement>(null)
    useEffect(() => alert.current?.focus(), [])

    return (
        <Screen>
            <Centre ref={alert} role="alert" tabIndex={-1}>
                <Title>Something went wrong</Title>
                <Text>{describe(error)}</Text>
                <Text>
                    Protocol wrote this to its log. To report it, use Save logs in Settings › Advanced and attach the file to a bug report.
                </Text>
                <Actions>
                    <Button variant="filled" onClick={() => window.location.reload()}>Reload</Button>
                    <Button variant="secondary" onClick={() => void navigate(paths.home)}>Back to meetings</Button>
                </Actions>
            </Centre>
        </Screen>
    )
}

/** The minibar's own error: its window has room for a line and Reload. */
export function MinibarError() {
    useLoggedRouteError()
    return (
        <MinibarWindow>
            <TransparentWindow/>
            <Pill role="alert">
                The bar stopped working
                <Button size="sm" variant="filled" onClick={() => window.location.reload()}>Reload</Button>
            </Pill>
        </MinibarWindow>
    )
}
