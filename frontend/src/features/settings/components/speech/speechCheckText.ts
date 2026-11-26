/** A device in the UI's words; the report keeps native's full name. */
export function deviceWords(device: string | undefined): string {
    if (!device) return ''
    if (device.startsWith('Intel GPU')) return 'Intel GPU'
    if (device.startsWith('Intel NPU')) return 'Intel NPU'
    if (device.startsWith('Apple GPU')) return 'Apple GPU'
    if (device.startsWith('GPU')) return 'graphics card'
    return 'processor'
}
