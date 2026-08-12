import { ConfigProvider } from 'issh-core'

/** @hidden */
export class ClickableLinksConfigProvider extends ConfigProvider {
    defaults = {
        clickableLinks: {
            modifier: null,
        },
    }

    platformDefaults = { }
}
