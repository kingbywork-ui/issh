import { mount } from 'svelte'
import App from './App.svelte'
import './app.css'
import { initPluginHost } from './lib/plugins/pluginHost'
import { registerBuiltinPlugins } from './lib/plugins/builtin'

registerBuiltinPlugins()
void initPluginHost()

mount(App, {
    target: document.getElementById('app')!,
})
