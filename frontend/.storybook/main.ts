import type {StorybookConfig} from '@storybook/react-vite'

// The Vite builder reads vite.config.ts, so stories resolve `@/` and build
// like the app.
const config: StorybookConfig = {
    stories: ['../src/**/*.stories.@(ts|tsx)'],
    framework: '@storybook/react-vite',
    core: {
        disableTelemetry: true,
    },
}

export default config
