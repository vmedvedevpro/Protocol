import {ExportSheet} from './export/ExportSheet'

/**
 * Every dialog over a screen (#119), mounted once by the shell under the
 * router, so a dialog can navigate and outlives the screen that opened it.
 * Screens open one with `openDialog` (src/lib/dialogs.ts); each sheet shows
 * while its kind is the one open.
 */
export function DialogHost() {
    return (
        <>
            <ExportSheet/>
        </>
    )
}
