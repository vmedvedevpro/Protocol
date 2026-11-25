import {createContext, useContext} from 'react'

/** The ids of a SettingsRow's label and description, for the control in it. */
export interface ControlLabelIds {
    labelId: string
    descriptionId?: string
}

export const ControlLabelContext = createContext<ControlLabelIds | null>(null)

/**
 * The ARIA naming for a control: its own `label` when it has one, otherwise
 * the label and description of the SettingsRow around it, so a row's text
 * names its switch or select without repeating it.
 */
export function useControlLabelling(label: string | undefined) {
    const row = useContext(ControlLabelContext)
    if (label !== undefined) return {'aria-label': label}
    if (!row) return {}
    return {'aria-labelledby': row.labelId, 'aria-describedby': row.descriptionId}
}
