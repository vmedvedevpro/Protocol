import {useState} from 'react'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'
import {AnimatePresence} from 'motion/react'
import * as m from 'motion/react-m'
import styled from 'styled-components'
import {completeOnboarding, onboardingKeys, onboardingStatusQuery, saveOnboardingStep} from '@/api/onboarding'
import {firstLaunchMeetingLanguage, saveSummaryModelMutation, useMeetingLanguageStore} from '@/api/preferences'
import {Screen} from '@/components/screen/Screen'
import {Button} from '@/components/ui/Button'
import {toast} from '@/components/ui/toastStore'
import {platform as appPlatform, type Platform} from '@/lib/platform'
import {Veil} from '@/components/ui/Veil'
import {statusSwap as swap, tween} from '@/styles/motion'
import {ModelsStep} from '../components/ModelsStep'
import {NAME_FORM_ID, NameStep} from '../components/NameStep'
import {type DownloadRow, useFirstLaunchDownloads} from '../hooks/useFirstLaunchDownloads'
import {type SummaryChoiceState, useSummaryChoice} from '../hooks/useSummaryChoice'

type Step = 1 | 2

// A step arrives as a screen does, with a 4 px rise under a veil; the one
// it replaces goes at once.
const StepView = styled(m.div)`
    position: relative;
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
    position: relative;
    ${({theme}) => theme.text.small};
    flex: 1;
    min-width: 0;
    color: ${({theme}) => theme.colors.muted};
`

const Actions = styled(m.span)`
    position: relative;
    display: flex;
    gap: ${({theme}) => theme.space[2]};
`

/** Live text, as `complete_onboarding` records it. */
const isReady = (rows: DownloadRow[], id: string) => rows.find((row) => row.download.id === id)?.state.kind === 'ready'

/** What the bar says while the summary choice keeps Done off. */
function summaryBlocker({way, builtIn, finish}: SummaryChoiceState): string | null {
    if (finish) return null
    if (way === 'builtIn') return builtIn?.state.kind === 'failed' ? 'Retry the model, or choose Later' : 'Install the model, or choose Later'
    return 'Paste a key and pick a model'
}

/**
 * First launch, in place of the app until it is done: the name, then the
 * speech downloads, the meeting language, the summary choice and the
 * microphone check. The downloads start when it opens and go on after Done.
 * A restart comes back to the step saved last. Done saves a provider's
 * summary choice and the meeting language, records
 * the choice and Parakeet (`complete_onboarding`) and invalidates the status
 * (`onboardingKeys.status()`), and the startup gate lets the app in.
 */
export function FirstLaunch({platform = appPlatform}: { platform?: Platform }) {
    const queryClient = useQueryClient()
    const savedStep = useQuery(onboardingStatusQuery).data?.current_step ?? 1
    const [step, setStep] = useState<Step>(savedStep >= 2 ? 2 : 1)
    const [moved, setMoved] = useState(false)
    const rows = useFirstLaunchDownloads()
    const summary = useSummaryChoice()
    const [language, setLanguage] = useState(firstLaunchMeetingLanguage)
    const blocker = summaryBlocker(summary)
    const saveSummary = useMutation(saveSummaryModelMutation)

    const goTo = (next: Step) => {
        setStep(next)
        setMoved(true)
        // Not saved, a restart only starts again at the name.
        saveOnboardingStep(next).catch(() => undefined)
    }

    const done = useMutation({
        mutationFn: async () => {
            const {finish} = summary
            if (!finish) throw new Error(blocker ?? 'Choose how summaries are written')
            if (finish.save) await saveSummary.mutateAsync(finish.save)
            // Stored as Settings stores it; `usePreferencesSync` sends it to native.
            useMeetingLanguageStore.getState().set(language)
            await completeOnboarding({summary: finish.summary, parakeetReady: isReady(rows, 'live')})
        },
        onSuccess: () => {
            const summaryDownloading = summary.way === 'builtIn' && summary.builtIn?.state.kind !== 'ready'
            if (summaryDownloading || rows.some(({state}) => state.kind !== 'ready')) {
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
                <Caption as={m.span} key={step === 1 ? 'name' : blocker ?? 'models'} {...swap}>
                    {step === 1 ? 'Step 1 of 2' : blocker ?? 'Downloads continue in the background'}
                    <Veil duration="fast"/>
                </Caption>
            </AnimatePresence>
            <AnimatePresence mode="wait" initial={false}>
                {step === 1 ? (
                    <Actions key="name" {...swap}>
                        <Button variant="filled" type="submit" form={NAME_FORM_ID}>Continue</Button>
                        <Veil duration="fast"/>
                    </Actions>
                ) : (
                    <Actions key="models" {...swap}>
                        <Button variant="ghost" onClick={() => goTo(1)}>Back</Button>
                        <Button variant="filled" disabled={blocker !== null} pending={done.isPending} onClick={() => done.mutate()}>Done</Button>
                        <Veil duration="fast"/>
                    </Actions>
                )}
            </AnimatePresence>
        </Bar>
    )

    return (
        <Screen bar={bar}>
            <StepView key={step} initial={{y: 4}} animate={{y: 0}} transition={tween('base', 'enter')}>
                {step === 1
                    ? <NameStep onContinue={() => goTo(2)}/>
                    : <ModelsStep rows={rows} summary={summary} language={language} onLanguage={setLanguage} platform={platform} focusOnMount={moved}/>}
                <Veil/>
            </StepView>
        </Screen>
    )
}
