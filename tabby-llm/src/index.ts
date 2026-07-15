/* eslint-disable @typescript-eslint/no-extraneous-class */
import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { NgbModule } from '@ng-bootstrap/ng-bootstrap'
import { ToastrModule } from 'ngx-toastr'

import TabbyCorePlugin, { ConfigProvider, HotkeyProvider } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'
import { TerminalDecorator } from 'tabby-terminal'

import { LLMConfigProvider } from './config'
import { LLMHotkeyProvider } from './hotkeys'
import { AgentBridgeSettingsTabProvider, LLMSettingsTabProvider, AboutSettingsTabProvider } from './settings'
import { LLMDecorator } from './decorator'
import { AutocompletePanelComponent } from './components/autocompletePanel.component'
import { LLMSettingsTabComponent } from './components/llmSettingsTab.component'
import { AgentBridgeSettingsTabComponent } from './components/agentBridgeSettingsTab.component'
import { AboutSettingsTabComponent } from './components/aboutSettingsTab.component'
import { LLMTerminalHostComponent } from './components/llmTerminalHost.component'

/** @hidden */
@NgModule({
    imports: [
        CommonModule,
        FormsModule,
        NgbModule,
        ToastrModule,
        TabbyCorePlugin,
    ],
    providers: [
        { provide: ConfigProvider, useClass: LLMConfigProvider, multi: true },
        { provide: HotkeyProvider, useClass: LLMHotkeyProvider, multi: true },
        { provide: SettingsTabProvider, useClass: LLMSettingsTabProvider, multi: true },
        { provide: SettingsTabProvider, useClass: AgentBridgeSettingsTabProvider, multi: true },
        { provide: SettingsTabProvider, useClass: AboutSettingsTabProvider, multi: true },
        { provide: TerminalDecorator, useClass: LLMDecorator, multi: true },
    ],
    declarations: [
        AutocompletePanelComponent,
        AgentBridgeSettingsTabComponent,
        AboutSettingsTabComponent,
        LLMSettingsTabComponent,
        LLMTerminalHostComponent,
    ],
})
export default class LLMModule { }

export * from './api'
