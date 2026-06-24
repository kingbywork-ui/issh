/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Injectable } from '@angular/core'
import { AppService, ToolbarButtonProvider, ToolbarButton, TranslateService } from 'tabby-core'

/** @hidden */
@Injectable()
export class ButtonProvider extends ToolbarButtonProvider {
    constructor (
        private app: AppService,
        private translate: TranslateService,
    ) {
        super()
    }

    provide (): ToolbarButton[] {
        return [
            {
                icon: require('./icons/home.svg'),
                title: this.translate.instant('Home'),
                weight: 10,
                click: () => {
                    this.app.showHomePage()
                },
            },
        ]
    }
}
