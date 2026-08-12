/* eslint-disable @typescript-eslint/no-extraneous-class */
import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { NgbModule } from '@ng-bootstrap/ng-bootstrap'
import { ToastrModule } from 'ngx-toastr'

import ISSHCorePlugin, { ConfigProvider, HotkeyProvider } from 'issh-core'
import { SettingsTabProvider } from 'issh-settings'
import { TerminalDecorator } from 'issh-terminal'

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
        ISSHCorePlugin,
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
