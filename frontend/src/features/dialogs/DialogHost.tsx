import {EnhanceSheet} from './enhance/EnhanceSheet'
import {ExportSheet} from './export/ExportSheet'
import {IdentifySpeakersSheet} from './identify/IdentifySpeakersSheet'
import {DropOverlay} from './import/DropOverlay'
import {ImportSheet} from './import/ImportSheet'
import {SpeakerSheet} from './speaker/SpeakerSheet'
import {SummaryOptionsSheet} from './summary/SummaryOptionsSheet'
import {TemplateSheet} from './template/TemplateSheet'

/**
 * Every dialog over a screen (#119), mounted once by the shell under the
 * router once first launch is done, so a dialog can navigate and outlives
 * the screen that opened it. Screens open one with `openDialog`
 * (src/lib/dialogs.ts); each sheet shows while its kind is the one open.
 * The window's drop-to-import overlay comes with them.
 */
export function DialogHost() {
    return (
        <>
            <ImportSheet/>
            <ExportSheet/>
            <EnhanceSheet/>
            <SummaryOptionsSheet/>
            <TemplateSheet/>
            <SpeakerSheet/>
            <IdentifySpeakersSheet/>
            <DropOverlay/>
        </>
    )
}
