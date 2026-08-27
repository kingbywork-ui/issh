import { mount } from 'svelte'
import App from './App.svelte'
import './app.css'
import { initPluginHost } from './lib/plugins/pluginHost'

void initPluginHost()

mount(App, {
    target: document.getElementById('app')!,
})
