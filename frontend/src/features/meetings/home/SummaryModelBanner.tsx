import {DownloadSimpleIcon} from '@phosphor-icons/react'
import {type BuiltInModelInfo, downloadBuiltInModel, stoppedDownloadShare} from '@/api/models'
import {Button} from '@/components/ui/Button'
import {Banner} from './Banner'

/**
 * Home's banner while summaries have no model to run: the download resumes
 * from the partial file native kept, or starts. Its progress then shows in
 * the downloads line and the banner goes.
 */
export function SummaryModelBanner({model}: {model: BuiltInModelInfo}) {
    const share = stoppedDownloadShare(model.status)
    const stopped = share !== null
    return (
        <Banner
            icon={<DownloadSimpleIcon aria-hidden/>}
            title="The summary model isn’t downloaded"
            description={`${stopped ? `${model.display_name} stopped downloading at ${share}%.` : `${model.display_name} isn’t on this computer.`} Summaries are written once it is.`}
            actions={(
                // A failure comes back as the download's event, which shows this banner again.
                <Button size="sm" variant="filled" onClick={() => void downloadBuiltInModel(model.name).catch(() => undefined)}>
                    {stopped ? 'Resume download' : 'Download'}
                </Button>
            )}
        />
    )
}
