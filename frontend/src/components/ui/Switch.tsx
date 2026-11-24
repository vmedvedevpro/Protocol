import * as RadixSwitch from '@radix-ui/react-switch'
import * as m from 'motion/react-m'
import styled from 'styled-components'
import {springs} from '@/styles/motion'
import {useControlLabelling} from './controlLabelling'
import {colorTransition, focusRing} from './styles'

// Off: a grey track and a light knob on the left. On: the track takes the
// text colour and the knob the window colour, on the right. The track's
// colour changes over `fast`; the knob moves on `springs.snappy`.
const Track = styled(RadixSwitch.Root)`
    display: inline-flex;
    flex: none;
    align-items: center;
    width: ${({theme}) => theme.sizes.switch.width};
    height: ${({theme}) => theme.sizes.switch.height};
    margin: 0;
    padding: ${({theme}) => theme.space[0.5]};
    border: 0;
    border-radius: ${({theme}) => theme.radii.pill};
    background: ${({theme}) => theme.colors.track};
    cursor: pointer;
    ${colorTransition};
    ${focusRing};

    &[data-state='checked'] {
        background: ${({theme}) => theme.colors.text};
    }

    &:disabled {
        cursor: default;
        opacity: 0.5;
    }
`

// The knob is half the inner track (32 − 2 × 2 = 28 = 2 × 14), so moving it by
// its own width lands it on the right edge: x 100%.
const Knob = styled(m.span)`
    display: block;
    width: calc(${({theme}) => theme.sizes.switch.height} - 2 * ${({theme}) => theme.space[0.5]});
    height: 100%;
    border-radius: ${({theme}) => theme.radii.pill};
    background: ${({theme}) => theme.colors.knob};
    ${colorTransition};

    &[data-state='checked'] {
        background: ${({theme}) => theme.colors.bg};
    }
`

interface SwitchProps {
    checked: boolean
    onCheckedChange: (checked: boolean) => void
    /** The accessible name; inside a SettingsRow the row's label names it instead. */
    label?: string
    disabled?: boolean
}

/** An on/off setting that applies at once. Space toggles it from the keyboard. */
export function Switch({checked, onCheckedChange, label, disabled}: SwitchProps) {
    const labelling = useControlLabelling(label)
    return (
        <Track
            checked={checked}
            onCheckedChange={onCheckedChange}
            disabled={disabled}
            {...labelling}
        >
            <RadixSwitch.Thumb asChild>
                <Knob initial={false} animate={{x: checked ? '100%' : '0%'}} transition={springs.snappy}/>
            </RadixSwitch.Thumb>
        </Track>
    )
}
