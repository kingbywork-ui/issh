import type { IsshPlugin } from './types'
import { registerPlugin } from './pluginHost'
import vaultPlugin from '../../../../plugins/issh-plugin-vault/index'

export function registerBuiltinPlugins (): void {
    registerPlugin(vaultPlugin satisfies IsshPlugin, 'builtin')
}
