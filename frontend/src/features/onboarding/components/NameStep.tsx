import styled from 'styled-components'
import {useUserNameStore} from '@/api/preferences'
import {Ring} from '@/components/ring/Ring'
import {TextField} from '@/components/ui/TextField'

/** The step's form; Continue in the window's footer submits it. */
export const NAME_FORM_ID = 'first-launch-name'

const Body = styled.form`
    display: flex;
    flex: 1;
    flex-direction: column;
    justify-content: center;
    min-height: 0;
    padding: 0 ${({theme}) => theme.space[9]} ${({theme}) => theme.space[6]};
`

// The ring's glow leaves room around it; pulled left, its circle lines up with the text.
const Logo = styled.div`
    margin-left: -${({theme}) => theme.space[3]};
`

const Title = styled.h1`
    ${({theme}) => theme.text.display};
    margin-top: ${({theme}) => theme.space[2]};
`

const Lead = styled.p`
    ${({theme}) => theme.text.body};
    margin-top: ${({theme}) => theme.space[2]};
    margin-bottom: ${({theme}) => theme.space[6]};
    color: ${({theme}) => theme.colors.muted};
`

/** Step 1: the name, kept where the app reads it (`meetily_user_name`) as it is typed. */
export function NameStep({onContinue}: { onContinue: () => void }) {
    const name = useUserNameStore((state) => state.value)
    const setName = useUserNameStore((state) => state.set)

    return (
        <Body
            id={NAME_FORM_ID}
            onSubmit={(event) => {
                event.preventDefault()
                onContinue()
            }}
        >
            <Logo><Ring mode="idle" size={96}/></Logo>
            <Title>Welcome to Protocol</Title>
            <Lead>Protocol records your meetings and writes the transcript and summary for you.</Lead>
            <TextField
                label="What should we call you?"
                hint="Shown instead of “You” in transcripts. You can change it in Settings."
                placeholder="Your name"
                size="lg"
                autoComplete="name"
                // The step is a form of one field: typing is what it is for.
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
            />
        </Body>
    )
}
