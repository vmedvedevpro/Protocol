import {command} from './core'

/**
 * Asks where to save a ZIP, through the dialog plugin's save dialog
 * (`dialog:allow-save`), starting at `defaultPath`. `null` when the user
 * cancels.
 */
export async function chooseZipDestination(defaultPath: string): Promise<string | null> {
    const ask = (path: string) => command<string | null>('plugin:dialog|save', {
        options: {defaultPath: path, filters: [{name: 'ZIP archive', extensions: ['zip']}]},
    })
    const destination = await ask(defaultPath)
    if (!destination || destination.toLowerCase().endsWith('.zip')) return destination
    // A GTK dialog returns the name as typed, without the filter's extension,
    // and asked about replacing only that name. Adding `.zip` here would
    // replace an existing ZIP unasked, so the dialog opens once more on the
    // name with `.zip` and its own overwrite prompt runs. A name still without
    // it is refused by native code, which writes only a `.zip`.
    return ask(`${destination}.zip`)
}
