/** "640 MB" or "1.6 GB" from bytes, as the old model lists wrote it; empty while unknown. */
export function formatModelSize(bytes: number | null | undefined): string {
    if (!bytes || bytes <= 0) return ''
    const megabytes = bytes / (1024 * 1024)
    if (megabytes >= 1024) return `${(megabytes / 1024).toFixed(1)} GB`
    return `${Math.max(1, Math.round(megabytes))} MB`
}

/** "Download · 640 MB", or the label alone while the size is unknown. */
export const withSize = (label: string, bytes: number | null | undefined) => {
    const size = formatModelSize(bytes)
    return size ? `${label} · ${size}` : label
}
