import {useQuery, useQueryClient} from '@tanstack/react-query'
import * as m from 'motion/react-m'
import styled from 'styled-components'
import {
    companionQuery,
    downloadGpuVersion,
    dismissIntelOffer,
    downloadIntelLibraries,
    INTEL_LIBRARIES_ID,
    intelError,
    isIntelCancelled,
    npuQuery,
    offerFor,
    openVinoAvailabilityQuery,
    useIntelOfferDismissedStore,
} from '@/api/intel'
import {trackIntelDownload} from '@/api/modelDownloadSync'
import {downloadKey, PARAKEET_MODEL} from '@/api/models'
import {Button} from '@/components/ui/Button'
import {Collapse} from '@/components/ui/Collapse'
import {toast} from '@/components/ui/toastStore'
import {Veil} from '@/components/ui/Veil'
import {formatModelSize} from '@/lib/sizes'
import {tween} from '@/styles/motion'
import {useSpeechModels} from '../../hooks/useSpeechModels'

const Banner = styled(m.section)`
    position: relative;
    padding: ${({theme}) => theme.space[3]};
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.xl};
    background: ${({theme}) => theme.colors.raised};
`

const Title = styled.h2`
    ${({theme}) => theme.text.body};
    font-weight: ${({theme}) => theme.fontWeights.semibold};
`

const Text = styled.p`
    margin-top: ${({theme}) => theme.space[0.5]};
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

const Actions = styled.div`
    display: flex;
    justify-content: flex-end;
    gap: ${({theme}) => theme.space[1.5]};
    margin-top: ${({theme}) => theme.space[2.5]};
`

/**
 * The offer at the top of Settings › AI after an update (#88): this
 * computer has an Intel GPU without Whisper's Intel GPU version, or an Intel
 * NPU without Intel's libraries. Switch downloads what is needed; native
 * makes the Intel GPU version the after-meeting model (`choose`), and the
 * NPU prepares itself. Not now is remembered per device
 * (`meetily-intel-offer-dismissed`); Speech models still offers it.
 */
export function IntelOfferBanner() {
    const queryClient = useQueryClient()
    const {parakeet, whisper, downloads} = useSpeechModels()
    const availability = useQuery(openVinoAvailabilityQuery).data
    const companion = useQuery(companionQuery).data
    const npu = useQuery(npuQuery).data
    const dismissed = useIntelOfferDismissedStore((state) => state.value)

    const running = (key: string) => downloads[key]?.state === 'downloading'
    const offer = npu ? offerFor({
        installedAny: [...parakeet, ...whisper].some(({status}) => status === 'Available'),
        availability,
        companion,
        npu,
        parakeetInstalled: parakeet.some(({name, status}) => name === PARAKEET_MODEL && status === 'Available'),
        librariesDownloading: running(downloadKey('intelLibraries', INTEL_LIBRARIES_ID)),
        dismissed,
    }) : null
    const gpuRunning = !!companion && running(downloadKey('intelGpu', companion.id))
    const shown = offer && !gpuRunning ? offer : null

    const switchNow = () => {
        if (!shown) return
        const done = shown.gpu && companion
            ? trackIntelDownload(queryClient, 'intelGpu', companion.id, () => downloadGpuVersion(companion.id, {choose: true}))
                .then(() => toast.success('Whisper is ready for the Intel GPU', {description: 'Transcripts after meetings use it from the next one on.'}))
            : trackIntelDownload(queryClient, 'intelLibraries', INTEL_LIBRARIES_ID, downloadIntelLibraries)
                .then(() => toast.success("Intel's libraries are installed", {description: 'Parakeet gets ready for the Intel NPU once, then runs on it.'}))
        void done.catch((error) => {
            if (!isIntelCancelled(error)) toast.error('The installation didn’t finish', {description: intelError(error)})
        })
    }

    const bytes = shown?.gpu ? companion?.downloadSize : companion?.runtime?.downloadSize
    return (
        // The slot opens and closes with the banner, so what is below slides.
        <Collapse open={!!shown}>
            {shown && (
                <Banner
                    aria-label="Intel GPU and NPU offer"
                    // Text never fades: it rises under a veil, which covers it
                    // again as it goes (Veil).
                    initial={{y: -4}}
                    animate={{y: 0}}
                    transition={tween('base', 'enter')}
                >
                    <Title>{shown.title}</Title>
                    <Text>{formatModelSize(bytes) ? `${shown.description} · ${formatModelSize(bytes)}` : shown.description}</Text>
                    <Actions>
                        <Button size="sm" variant="ghost" onClick={() => dismissIntelOffer(shown.devices)}>Not now</Button>
                        <Button size="sm" variant="filled" onClick={switchNow}>Install</Button>
                    </Actions>
                    <Veil outset={1}/>
                </Banner>
            )}
        </Collapse>
    )
}
