/**
 * Where the recording sends the user: its own screen as a start begins, the
 * saved meeting after Stop, and the speech models when a start or a recording
 * needs one. Both need the router,
 * which only a component has; RecordingRuntime registers them.
 */
export const links = {
    /** The recording screen, as a start begins. */
    openRecording: () => {},
    openMeeting: (_meetingId: string) => {},
    openSpeechModels: () => {},
}

export function registerLinks(next: typeof links) {
    Object.assign(links, next)
}
