import {MotionGlobalConfig} from 'motion/react'

/**
 * Lets motion play for real in one test: setup.ts ends every animation at
 * once and turns that back on after each test. MotionProvider loads the
 * animation features by a dynamic import; loaded first, they are in place
 * one macrotask after the render (settleIpc).
 */
export async function playAnimations() {
    MotionGlobalConfig.skipAnimations = false
    await import('@/components/ui/motionFeatures')
}

/**
 * Records each inline style written under `root` from now on, so a test
 * reads the whole path of an animation instead of sampling it at a moment,
 * which a busy machine makes late. motion writes once per frame, each frame
 * in a task of its own, so no frame is merged with the next.
 */
export function watchStyles(root: Node = document.body) {
    const writes: { element: Element, style: string }[] = []
    const observer = new MutationObserver((records) => {
        for (const {target} of records) {
            const element = target as Element
            writes.push({element, style: element.getAttribute('style') ?? ''})
        }
    })
    observer.observe(root, {subtree: true, attributes: true, attributeFilter: ['style']})
    const reader = document.createElement('div')
    return {
        /** The values one property took on one element, in order, repeats dropped. */
        valuesOf(element: Element, property: string) {
            const values: string[] = []
            for (const write of writes) {
                if (write.element !== element) continue
                reader.setAttribute('style', write.style)
                const value = reader.style.getPropertyValue(property)
                if (values.at(-1) !== value) values.push(value)
            }
            return values
        },
        stop: () => observer.disconnect(),
    }
}
