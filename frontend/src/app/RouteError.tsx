import {useEffect} from 'react'
import {isRouteErrorResponse, useNavigate, useRouteError} from 'react-router-dom'
import styled from 'styled-components'
import {errorMessage} from '@/api/core'
import {logWebViewError} from '@/api/logs'
import {Screen} from '@/components/screen/Screen'
import {Button} from '@/components/ui/Button'
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

const describe = (error: unknown) =>
    isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : errorMessage(error)

/**
 * A screen that threw while rendering: React Router's error boundary shows
 * this in its place and the error goes to the native log. Inside the shell
 * the title bar stays, so Settings › Advanced › Save logs is a click away.
 */
export function RouteError() {
    const error = useRouteError()
    const navigate = useNavigate()
    useEffect(() => {
        logWebViewError('screen error', error)
    }, [error])

    return (
        <Screen>
            <Centre>
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
