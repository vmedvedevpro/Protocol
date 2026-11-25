import {describe, expect, it} from 'vitest'
import {
    type CompanionStatus,
    gpuFallback,
    INTEL_OFFER_DISMISSED_KEY,
    intelError,
    NPU_ABSENT,
    offerFor,
    type ParakeetNpuStatus,
    dismissIntelOffer,
} from './intel'

const companion = (patch: Partial<CompanionStatus> = {}) => ({
    id: 'gpu', installed: false, refused: null, downloading: null, stopped: null, ...patch,
} as CompanionStatus)
const npu: ParakeetNpuStatus = {present: true, state: 'needs_runtime', active: false, reason: null}
const base = {installedAny: true, availability: {offer: true, reason: null, device: null}, companion: companion(), npu: NPU_ABSENT, parakeetInstalled: true, librariesDownloading: false, dismissed: []}

describe('offerFor', () => {
    it('offers the Intel GPU version on an Intel GPU, and nothing before any model is installed', () => {
        expect(offerFor(base)).toMatchObject({devices: ['Intel GPU'], gpu: true, title: 'Protocol can use your Intel GPU'})
        expect(offerFor({...base, installedAny: false})).toBeNull()
        expect(offerFor({...base, companion: companion({installed: true})})).toBeNull()
        expect(offerFor({...base, companion: companion({refused: 'Update Protocol'})})).toBeNull()
    })

    it('offers Intel’s libraries for an NPU only while Parakeet v3 is installed', () => {
        const npuOnly = {...base, availability: {offer: false, reason: null, device: null}, npu}
        expect(offerFor(npuOnly)).toMatchObject({devices: ['Intel NPU'], gpu: false})
        expect(offerFor({...npuOnly, parakeetInstalled: false})).toBeNull()
        expect(offerFor({...npuOnly, librariesDownloading: true})).toBeNull()
    })

    it('stays hidden after Not now until a device it did not offer comes up', () => {
        expect(offerFor({...base, dismissed: ['Intel GPU']})).toBeNull()
        expect(offerFor({...base, npu, dismissed: ['Intel GPU']})).toMatchObject({devices: ['Intel GPU', 'Intel NPU']})
    })
})

describe('gpuFallback', () => {
    it('says why an installed Intel GPU version does not run', () => {
        expect(gpuFallback(companion({installed: true, stopped: 'Closed inside it'}), null)).toBe('Closed inside it')
        expect(gpuFallback(companion({installed: true}), {reason: null, device: null, mismatch: 'Wrong GPU'})).toBe('Wrong GPU')
        expect(gpuFallback(companion(), null, 'Failed')).toBeNull()
    })
})

describe('intelError', () => {
    it('never names OpenVINO', () => {
        expect(intelError('Not enough free space for openvino: 2 GB needed.')).toBe('Not enough free space: 2 GB needed.')
        expect(intelError('OpenVINO plugin failed')).toBe("Something went wrong with Intel's libraries. Try again later.")
        expect(intelError('Network down')).toBe('Network down')
    })
})

describe('Not now', () => {
    it('keeps the dismissed devices as a bare list, and removes the key when there are none', () => {
        dismissIntelOffer(['Intel GPU'])
        expect(JSON.parse(localStorage.getItem(INTEL_OFFER_DISMISSED_KEY) ?? 'null')).toEqual(['Intel GPU'])
    })
})
