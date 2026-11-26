import type {CheckDevice, CheckDeviceKind} from '@/api/speechCheck'

const DEVICE_WORDS: Record<CheckDeviceKind, string> = {
    processor: 'processor',
    intelNpu: 'Intel NPU',
    intelGpu: 'Intel GPU',
    directMl: 'graphics card',
    vulkan: 'graphics card',
    metal: 'Apple GPU',
    cuda: 'graphics card',
    hip: 'graphics card',
}

/** A device in the UI's words, by its kind; a kind this list does not know yet shows native's name. */
export function deviceWords(device: CheckDevice): string {
    return Object.hasOwn(DEVICE_WORDS, device.kind) ? DEVICE_WORDS[device.kind] : device.name
}
