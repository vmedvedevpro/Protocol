/**
 * The two language lists of the app. They are contracts with native code,
 * not display choices: a code outside either list fails or is ignored
 * natively, so add a language here only together with native support.
 */

export interface Language {
    code: string
    label: string
}

/** Detect the spoken language and keep the transcript in it. */
export const DETECT_LANGUAGE = 'auto'
/** Detect the spoken language and translate the transcript to English (Whisper). */
export const DETECT_AND_TRANSLATE = 'auto-translate'

/**
 * The meeting language: what people speak, which Whisper is told before it
 * transcribes (`set_language_preference`); Parakeet always detects it. Whisper's
 * ISO 639-1 codes, as the old UI listed them (`components/LanguageSelection.tsx`
 * at 162e8be).
 */
export const MEETING_LANGUAGES: readonly Language[] = [
    {code: DETECT_LANGUAGE, label: 'Detect automatically'},
    {code: DETECT_AND_TRANSLATE, label: 'Detect and translate to English'},
    {code: 'en', label: 'English'},
    {code: 'zh', label: 'Chinese'},
    {code: 'de', label: 'German'},
    {code: 'es', label: 'Spanish'},
    {code: 'ru', label: 'Russian'},
    {code: 'ko', label: 'Korean'},
    {code: 'fr', label: 'French'},
    {code: 'ja', label: 'Japanese'},
    {code: 'pt', label: 'Portuguese'},
    {code: 'tr', label: 'Turkish'},
    {code: 'pl', label: 'Polish'},
    {code: 'ca', label: 'Catalan'},
    {code: 'nl', label: 'Dutch'},
    {code: 'ar', label: 'Arabic'},
    {code: 'sv', label: 'Swedish'},
    {code: 'it', label: 'Italian'},
    {code: 'id', label: 'Indonesian'},
    {code: 'hi', label: 'Hindi'},
    {code: 'fi', label: 'Finnish'},
    {code: 'vi', label: 'Vietnamese'},
    {code: 'he', label: 'Hebrew'},
    {code: 'uk', label: 'Ukrainian'},
    {code: 'el', label: 'Greek'},
    {code: 'ms', label: 'Malay'},
    {code: 'cs', label: 'Czech'},
    {code: 'ro', label: 'Romanian'},
    {code: 'da', label: 'Danish'},
    {code: 'hu', label: 'Hungarian'},
    {code: 'ta', label: 'Tamil'},
    {code: 'no', label: 'Norwegian'},
    {code: 'th', label: 'Thai'},
    {code: 'ur', label: 'Urdu'},
    {code: 'hr', label: 'Croatian'},
    {code: 'bg', label: 'Bulgarian'},
    {code: 'lt', label: 'Lithuanian'},
    {code: 'la', label: 'Latin'},
    {code: 'mi', label: 'Maori'},
    {code: 'ml', label: 'Malayalam'},
    {code: 'cy', label: 'Welsh'},
    {code: 'sk', label: 'Slovak'},
    {code: 'te', label: 'Telugu'},
    {code: 'fa', label: 'Persian'},
    {code: 'lv', label: 'Latvian'},
    {code: 'bn', label: 'Bengali'},
    {code: 'sr', label: 'Serbian'},
    {code: 'az', label: 'Azerbaijani'},
    {code: 'sl', label: 'Slovenian'},
    {code: 'kn', label: 'Kannada'},
    {code: 'et', label: 'Estonian'},
    {code: 'mk', label: 'Macedonian'},
    {code: 'br', label: 'Breton'},
    {code: 'eu', label: 'Basque'},
    {code: 'is', label: 'Icelandic'},
    {code: 'hy', label: 'Armenian'},
    {code: 'ne', label: 'Nepali'},
    {code: 'mn', label: 'Mongolian'},
    {code: 'bs', label: 'Bosnian'},
    {code: 'kk', label: 'Kazakh'},
    {code: 'sq', label: 'Albanian'},
    {code: 'sw', label: 'Swahili'},
    {code: 'gl', label: 'Galician'},
    {code: 'mr', label: 'Marathi'},
    {code: 'pa', label: 'Punjabi'},
    {code: 'si', label: 'Sinhala'},
    {code: 'km', label: 'Khmer'},
    {code: 'sn', label: 'Shona'},
    {code: 'yo', label: 'Yoruba'},
    {code: 'so', label: 'Somali'},
    {code: 'af', label: 'Afrikaans'},
    {code: 'oc', label: 'Occitan'},
    {code: 'ka', label: 'Georgian'},
    {code: 'be', label: 'Belarusian'},
    {code: 'tg', label: 'Tajik'},
    {code: 'sd', label: 'Sindhi'},
    {code: 'gu', label: 'Gujarati'},
    {code: 'am', label: 'Amharic'},
    {code: 'yi', label: 'Yiddish'},
    {code: 'lo', label: 'Lao'},
    {code: 'uz', label: 'Uzbek'},
    {code: 'fo', label: 'Faroese'},
    {code: 'ht', label: 'Haitian Creole'},
    {code: 'ps', label: 'Pashto'},
    {code: 'tk', label: 'Turkmen'},
    {code: 'nn', label: 'Norwegian Nynorsk'},
    {code: 'mt', label: 'Maltese'},
    {code: 'sa', label: 'Sanskrit'},
    {code: 'lb', label: 'Luxembourgish'},
    {code: 'my', label: 'Myanmar'},
    {code: 'bo', label: 'Tibetan'},
    {code: 'tl', label: 'Tagalog'},
    {code: 'mg', label: 'Malagasy'},
    {code: 'as', label: 'Assamese'},
    {code: 'tt', label: 'Tatar'},
    {code: 'haw', label: 'Hawaiian'},
    {code: 'ln', label: 'Lingala'},
    {code: 'ha', label: 'Hausa'},
    {code: 'ba', label: 'Bashkir'},
    {code: 'jw', label: 'Javanese'},
    {code: 'su', label: 'Sundanese'},
]

export function meetingLanguageLabel(code: string): string {
    return MEETING_LANGUAGES.find((language) => language.code === code)?.label ?? code
}

/**
 * The languages a summary can be written in. The codes must stay in step with
 * `language_name_from_code` in src-tauri/src/summary/processor.rs: saving a
 * code it does not know for a meeting fails, and a summary asked for in one
 * comes out in English without an error.
 */
export const SUMMARY_LANGUAGES: readonly Language[] = [
    {code: 'en', label: 'English'},
    {code: 'zh', label: 'Chinese'},
    {code: 'zh-tw', label: 'Traditional Chinese'},
    {code: 'de', label: 'German'},
    {code: 'es', label: 'Spanish'},
    {code: 'ru', label: 'Russian'},
    {code: 'ko', label: 'Korean'},
    {code: 'fr', label: 'French'},
    {code: 'ja', label: 'Japanese'},
    {code: 'pt', label: 'Portuguese'},
    {code: 'it', label: 'Italian'},
    {code: 'nl', label: 'Dutch'},
    {code: 'pl', label: 'Polish'},
    {code: 'ar', label: 'Arabic'},
    {code: 'hi', label: 'Hindi'},
    {code: 'ta', label: 'Tamil'},
    {code: 'tr', label: 'Turkish'},
    {code: 'vi', label: 'Vietnamese'},
    {code: 'th', label: 'Thai'},
    {code: 'id', label: 'Indonesian'},
    {code: 'sv', label: 'Swedish'},
    {code: 'cs', label: 'Czech'},
    {code: 'da', label: 'Danish'},
    {code: 'fi', label: 'Finnish'},
    {code: 'el', label: 'Greek'},
    {code: 'he', label: 'Hebrew'},
    {code: 'hu', label: 'Hungarian'},
    {code: 'no', label: 'Norwegian'},
    {code: 'ro', label: 'Romanian'},
    {code: 'uk', label: 'Ukrainian'},
]

const SUMMARY_CODES: ReadonlySet<string> = new Set(SUMMARY_LANGUAGES.map((language) => language.code))

/**
 * A summary language code from a stored value or a detected locale: regional
 * tags fall back to their language (`pt-BR` → `pt`, `en_GB` → `en`), and a
 * language summaries cannot be written in gives null, so callers fall back
 * instead of sending a code native code would drop.
 */
export function normaliseSummaryLanguage(raw: string | null | undefined): string | null {
    if (!raw) return null
    const lower = raw.toLowerCase().replace(/_/g, '-')
    if (SUMMARY_CODES.has(lower)) return lower
    const base = lower.split('-')[0]
    return SUMMARY_CODES.has(base) ? base : null
}

export function summaryLanguageLabel(code: string): string {
    return SUMMARY_LANGUAGES.find((language) => language.code === code)?.label ?? code
}
