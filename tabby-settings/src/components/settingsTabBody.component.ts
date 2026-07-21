import { Component, HostBinding, Input, ViewContainerRef, ViewChild, ComponentFactoryResolver, ComponentRef, OnDestroy, AfterViewInit } from '@angular/core'
import { SettingsTabProvider } from '../api'

/** @hidden */
@Component({
    selector: 'settings-tab-body',
    template: '<ng-template #placeholder></ng-template>',
    styles: [`
        :host {
            display: block;
            padding-bottom: 20px;
            max-width: 600px;
        }

        :host(.full-width) {
            display: flex;
            flex-direction: column;
            flex: 1 1 auto;
            min-height: 0;
            width: 100%;
            max-width: none;
            padding-bottom: 0;
        }
    `],
})
export class SettingsTabBodyComponent implements AfterViewInit, OnDestroy {
    @Input() provider: SettingsTabProvider
    @ViewChild('placeholder', { read: ViewContainerRef }) placeholder: ViewContainerRef
    component: ComponentRef<unknown> | null = null

    private destroyed = false
    private createHandle: ReturnType<typeof setImmediate> | null = null

    @HostBinding('class.full-width')
    get fullWidth (): boolean {
        return !!this.provider?.fullWidth
    }

    constructor (private componentFactoryResolver: ComponentFactoryResolver) { }

    ngAfterViewInit (): void {
        // Defer until after CD; cancel if destroyed first (ngbNav destroyOnHide).
        this.createHandle = setImmediate(() => {
            this.createHandle = null
            if (this.destroyed || !this.placeholder || !this.provider?.getComponentType()) {
                return
            }
            this.component = this.placeholder.createComponent(
                this.componentFactoryResolver.resolveComponentFactory(
                    this.provider.getComponentType(),
                ),
            )
        })
    }

    ngOnDestroy (): void {
        this.destroyed = true
        if (this.createHandle != null) {
            clearImmediate(this.createHandle)
            this.createHandle = null
        }
        if (this.component) {
            this.component.destroy()
            this.component = null
        }
    }
}
