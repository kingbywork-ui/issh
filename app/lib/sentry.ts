if (!process.env.TABBY_DEV && process.env.TABBY_ENABLE_SENTRY === '1') {
    const { init } = String(process.type) === 'main' ? require('@sentry/electron/main') : require('@sentry/electron/renderer')
    const SENTRY_DSN = 'https://4717a0a7ee0b4429bd3a0f06c3d7eec3@sentry.io/181876'
    let release = null
    try {
        release = require('electron').app.getVersion()
    } catch {
        release = require('@electron/remote').app.getVersion()
    }

    init({
        dsn: SENTRY_DSN,
        release,
        integrations (integrations) {
            return integrations.filter(integration => integration.name !== 'Breadcrumbs')
        },
    })
}
