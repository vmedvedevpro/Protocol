import {useState} from 'react'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'
import {AnimatePresence} from 'motion/react'
import * as m from 'motion/react-m'
import styled from 'styled-components'
import {recommendedSummaryModelQuery} from '@/api/models'
import {completeOnboarding, onboardingKeys, onboardingStatusQuery, saveOnboardingStep} from '@/api/onboarding'
import {Screen} from '@/components/screen/Screen'
import {Button} from '@/components/ui/Button'
import {toast} from '@/components/ui/toastStore'
import {platform as appPlatform, type Platform} from '@/lib/platform'
import {tween} from '@/styles/motion'
import {ModelsStep} from '../components/ModelsStep'
import {NAME_FORM_ID, NameStep} from '../components/NameStep'
import {type DownloadRow, useFirstLaunchDownloads} from '../hooks/useFirstLaunchDownloads'

type Step = 1 | 2

// A step arrives as a screen does, with a fade and a 4 px rise; the one it
// replaces goes at once.
const StepView = styled(m.div)`
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
`

const Bar = styled.div`
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[2]};
    height: ${({theme}) => theme.sizes.bar.footer};
    padding: 0 ${({theme}) => theme.space[3]} 0 ${({theme}) => theme.space[4]};
`

const Dots = styled.span`
    display: flex;
    gap: ${({theme}) => theme.space[1]};
`

const Dot = styled.span<{ $on: boolean }>`
    width: ${({theme}) => theme.space[4]};
    height: ${({theme}) => theme.space[1]};
    border-radius: ${({theme}) => theme.space[0.5]};
    background: ${({theme, $on}) => $on ? theme.colors.text : theme.colors.border};
    transition: background-color ${({theme}) => theme.motion.duration.base} ${({theme}) => theme.motion.easing.standard};
`

const Caption = styled.span`
    ${({theme}) => theme.text.small};
    flex: 1;
    min-width: 0;
    color: ${({theme}) => theme.colors.muted};
`

const Actions = styled(m.span)`
    display: flex;
    gap: ${({theme}) => theme.space[2]};
`

const swap = {
    initial: {opacity: 0, y: 4},
    animate: {opacity: 1, y: 0},
    exit: {opacity: 0, y: -4},
    transition: tween('fast'),
}

/** Live text and summaries, as `complete_onboarding` records them. */
const isReady = (rows: DownloadRow[], id: string) => rows.find((row) => row.download.id === id)?.state.kind === 'ready'

/**
 * First launch, in place of the app until it is done: the name, then the
 * downloads with the microphone check. The downloads start when it opens and
 * go on after Done. A restart comes back to the step saved last. Done
 * records the models (`complete_onboarding`) and invalidates the status
 * (`onboardingKeys.status()`), and the startup gate lets the app in.
 */
export function FirstLaunch({platform = appPlatform}: { platform?: Platform }) {
    const queryClient = useQueryClient()
    const savedStep = useQuery(onboardingStatusQuery).data?.current_step ?? 1
    const [step, setStep] = useState<Step>(savedStep >= 2 ? 2 : 1)
    const [moved, setMoved] = useState(false)
    const rows = useFirstLaunchDownloads()

    const goTo = (next: Step) => {
        setStep(next)
        setMoved(true)
        // Not saved, a restart only starts again at the name.
        saveOnboardingStep(next).catch(() => undefined)
    }

    const done = useMutation({
        mutationFn: async () => {
            const model = await queryClient.fetchQuery(recommendedSummaryModelQuery)
            await completeOnboarding({model, parakeetReady: isReady(rows, 'live'), summaryReady: isReady(rows, 'summaries')})
        },
        onSuccess: () => {
            if (rows.some(({state}) => state.kind !== 'ready')) {
                toast.info('Downloads continue in the background', {
                    description: 'You can start using the app. Recording will be available once speech recognition is ready.',
                })
            }
            // Pending until the gate has read the status again and lets the app in.
            return queryClient.invalidateQueries({queryKey: onboardingKeys.status()})
        },
        onError: (error) => toast.error('Could not finish setup', {description: error.message}),
    })

    const bar = (
        <Bar>
            <Dots aria-hidden="true">
                <Dot $on/>
                <Dot $on={step === 2}/>
            </Dots>
            <AnimatePresence mode="wait" initial={false}>
                <Caption as={m.span} key={step} {...swap}>
                    {step === 1 ? 'Step 1 of 2' : 'Downloads continue in the background'}
                </Caption>
            </AnimatePresence>
            <AnimatePresence mode="wait" initial={false}>
                {step === 1 ? (
                    <Actions key="name" {...swap}>
                        <Button variant="filled" type="submit" form={NAME_FORM_ID}>Continue</Button>
                    </Actions>
                ) : (
                    <Actions key="models" {...swap}>
                        <Button variant="ghost" onClick={() => goTo(1)}>Back</Button>
                        <Button variant="filled" pending={done.isPending} onClick={() => done.mutate()}>Done</Button>
                    </Actions>
                )}
            </AnimatePresence>
        </Bar>
    )

    return (
        <Screen bar={bar}>
            <StepView key={step} initial={{opacity: 0, y: 4}} animate={{opacity: 1, y: 0}} transition={tween('base', 'enter')}>
                {step === 1
                    ? <NameStep onContinue={() => goTo(2)}/>
                    : <ModelsStep rows={rows} platform={platform} focusOnMount={moved}/>}
            </StepView>
        </Screen>
    )
}
