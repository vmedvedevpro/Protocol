import {afterEach, describe, expect, it} from 'vitest'
import {closedStyle, collapseSpace} from './collapseSpace'

const column = (html: string) => {
    document.body.innerHTML = `<style>.card > * + * { border-top: 1px solid; }</style>
        <div class="card" style="display: flex; flex-direction: column; row-gap: 8px">${html}</div>`
    return document.getElementById('clip') as HTMLElement
}

describe('collapseSpace', () => {
    afterEach(() => {
        document.body.innerHTML = ''
    })

    it('takes the gap before it and its hairline, so closed it adds nothing to the column', () => {
        const space = collapseSpace(column('<p>Save audio</p><div id="clip"></div>'))

        expect(space).toEqual({gap: 8, side: 'marginTop', borderTop: 1, borderBottom: 0})
        expect(closedStyle(space)).toEqual({height: 0, borderTopWidth: 0, borderBottomWidth: 0, marginTop: -8})
    })

    it('takes the gap after it when it comes first, and none when it is alone', () => {
        expect(collapseSpace(column('<div id="clip"></div><p>Path</p>'))).toMatchObject({gap: 8, side: 'marginBottom', borderTop: 0})
        expect(collapseSpace(column('<div id="clip"></div>')).gap).toBe(0)
    })

    it('takes no gap from a row, whose gap runs across', () => {
        document.body.innerHTML = '<div style="display: flex; gap: 8px"><p>Label</p><div id="clip"></div></div>'

        expect(collapseSpace(document.getElementById('clip') as HTMLElement).gap).toBe(0)
    })
})
