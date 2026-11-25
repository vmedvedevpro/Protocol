/**
 * Geist for PDF export, with its Cyrillic (fonts/README.md). Inlined as
 * base64 into this module, which formats.ts imports only when a PDF is
 * made, so the app's own bundle does not carry it.
 */
import bold from './fonts/Geist-Bold.ttf?inline'
import regular from './fonts/Geist-Regular.ttf?inline'

export const PDF_FONT = 'Geist'

const base64 = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(',') + 1)

/** The two weights as jsPDF adds them: the file name, the style, the base64 bytes. */
export const PDF_FONT_FILES: readonly { file: string, style: 'normal' | 'bold', data: string }[] = [
    {file: 'Geist-Regular.ttf', style: 'normal', data: base64(regular)},
    {file: 'Geist-Bold.ttf', style: 'bold', data: base64(bold)},
]
