import {SpeechModels} from './speech/SpeechModels'
import {SubpageGroups, SubpageScroll} from './subpage'

/** Settings › AI › Speech models: the speech half's groups under the page's scroll. */
export function SpeechModelsPage() {
    return <SubpageScroll><SubpageGroups><SpeechModels/></SubpageGroups></SubpageScroll>
}
