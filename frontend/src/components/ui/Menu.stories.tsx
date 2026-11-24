import {useState} from 'react'
import type {Meta, StoryObj} from '@storybook/react-vite'
import {
    CaretDownIcon,
    DotsThreeIcon,
    ExportIcon,
    FolderIcon,
    PencilSimpleIcon,
    TrashIcon,
} from '@phosphor-icons/react'
import styled from 'styled-components'
import {formatShortcut} from '@/lib/platform'
import {Button, IconButton} from './Button'
import {
    Menu,
    MenuCheckboxItem,
    MenuGroup,
    MenuItem,
    MenuRadioGroup,
    MenuRadioItem,
    MenuSeparator,
    MenuSub,
} from './Menu'

const Row = styled.div`
    display: flex;
    align-items: flex-start;
    gap: ${({theme}) => theme.space[8]};
    height: 260px;
`

// The meeting's "More actions" with a submenu of folders, and the record
// bar's inputs: one microphone out of several, and the computer's sound on
// or off.
function Menus() {
    const [microphone, setMicrophone] = useState('headset')
    const [computerAudio, setComputerAudio] = useState(true)

    return (
        <Row>
            <Menu trigger={<IconButton label="More actions"><DotsThreeIcon/></IconButton>} align="start">
                <MenuItem icon={<PencilSimpleIcon/>} onSelect={() => {}}>Rename</MenuItem>
                <MenuSub icon={<FolderIcon/>} label="Move to folder">
                    <MenuItem onSelect={() => {}}>Acme Corp</MenuItem>
                    <MenuItem onSelect={() => {}}>Hiring</MenuItem>
                    <MenuItem onSelect={() => {}}>Weekly syncs</MenuItem>
                </MenuSub>
                <MenuItem icon={<ExportIcon/>} shortcut={formatShortcut('E')} onSelect={() => {}}>Export</MenuItem>
                <MenuSeparator/>
                <MenuItem icon={<TrashIcon/>} onSelect={() => {}} disabled>Delete while processing</MenuItem>
            </Menu>

            <Menu trigger={<Button size="sm" variant="ghost" trailing={<CaretDownIcon size={11}/>}>Headset + all apps</Button>} align="start">
                <MenuGroup label="Microphone">
                    <MenuRadioGroup value={microphone} onValueChange={setMicrophone}>
                        <MenuRadioItem value="headset">Headset</MenuRadioItem>
                        <MenuRadioItem value="builtin">MacBook Pro Microphone</MenuRadioItem>
                        <MenuRadioItem value="none">No microphone</MenuRadioItem>
                    </MenuRadioGroup>
                </MenuGroup>
                <MenuSeparator/>
                <MenuGroup label="Computer audio">
                    <MenuCheckboxItem checked={computerAudio} onCheckedChange={setComputerAudio}>
                        Record all apps
                    </MenuCheckboxItem>
                </MenuGroup>
            </Menu>
        </Row>
    )
}

const meta = {
    title: 'UI/Menu',
    component: Menus,
} satisfies Meta<typeof Menus>

export default meta

type Story = StoryObj<typeof meta>

export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}
