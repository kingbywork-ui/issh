/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Observable, OperatorFunction, debounceTime, map, distinctUntilChanged } from 'rxjs'
import { Component, Input, ViewChild, ViewContainerRef, ComponentFactoryResolver, Injector } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { PartialProfileGroup, Profile, ProfileProvider, ProfileSettingsComponent, ProfilesService, TAB_COLORS, ProfileGroup, ConnectableProfileProvider, FullyDefined, ConfigProxy } from 'issh-core'
import { Socket } from 'net'

const iconsData = require('../../../issh-core/src/icons.json')
const iconsClassList = Object.keys(iconsData).map(
    icon => iconsData[icon].map(
        style => `fa${style[0]} fa-${icon}`,
    ),
).flat()

/** @hidden */
@Component({
    standalone: false,
    templateUrl: './editProfileModal.component.pug',
})
export class EditProfileModalComponent<P extends Profile, PP extends ProfileProvider<P>> {
    @Input('profile') partialProfile: P
    @Input() profileProvider: PP
    @Input() settingsComponent: new () => ProfileSettingsComponent<P, PP>
    @Input() defaultsMode: 'enabled'|'group'|'disabled' = 'disabled'
    @Input() profileGroup: PartialProfileGroup<ProfileGroup> | undefined
    groups: PartialProfileGroup<ProfileGroup>[]
    @ViewChild('placeholder', { read: ViewContainerRef }) placeholder: ViewContainerRef

    testing = false
    testResult: 'success'|'fail'|null = null
    testMessage: string|null = null

    protected profile: FullyDefined<P> & ConfigProxy<FullyDefined<P>>
    private settingsComponentInstance?: ProfileSettingsComponent<P, PP>

    constructor (
        private injector: Injector,
        private componentFactoryResolver: ComponentFactoryResolver,
        private profilesService: ProfilesService,
        private modalInstance: NgbActiveModal,
    ) {
        if (this.defaultsMode === 'disabled') {
            this.profilesService.getProfileGroups().then(groups => {
                this.groups = groups
                this.profileGroup = groups.find(g => g.id === this.partialProfile.group)
            })
        }
    }

    colorsAutocomplete = text$ => text$.pipe(
        debounceTime(200),
        distinctUntilChanged(),
        map((q: string) =>
            TAB_COLORS
                .filter(x => !q || x.name.toLowerCase().startsWith(q.toLowerCase()))
                .map(x => x.value),
        ),
    )

    colorsFormatter = value => {
        return TAB_COLORS.find(x => x.value === value)?.name ?? value
    }

    ngOnInit () {
        this.profile = this.profilesService.getConfigProxyForProfile<P>(this.partialProfile, { skipGlobalDefaults: this.defaultsMode === 'enabled', skipGroupDefaults: this.defaultsMode === 'group' })
    }

    ngAfterViewInit () {
        const componentType = this.profileProvider.settingsComponent
        if (componentType) {
            setTimeout(() => {
                const componentFactory = this.componentFactoryResolver.resolveComponentFactory(componentType)
                const componentRef = componentFactory.create(this.injector)
                this.settingsComponentInstance = componentRef.instance
                this.settingsComponentInstance.profile = this.profile
                this.placeholder.insert(componentRef.hostView)
            })
        }
    }

    groupTypeahead: OperatorFunction<string, readonly PartialProfileGroup<ProfileGroup>[]> = (text$: Observable<string>) =>
        text$.pipe(
            debounceTime(200),
            distinctUntilChanged(),
            map(q => this.groups.filter(g => !q || g.name.toLowerCase().includes(q.toLowerCase()))),
        )

    groupFormatter = (g: PartialProfileGroup<ProfileGroup>) => g.name

    iconSearch: OperatorFunction<string, string[]> = (text$: Observable<string>) =>
        text$.pipe(
            debounceTime(200),
            map(term => iconsClassList.filter(v => v.toLowerCase().includes(term.toLowerCase())).slice(0, 10)),
        )

    async testConnection () {
        if (this.defaultsMode !== 'disabled') {
            return
        }
        this.testing = true
        this.testResult = null
        this.testMessage = null

        try {
            const host = this.profile.options?.host
            const port = this.profile.options?.port ?? 22
            if (!host) {
                this.testResult = 'fail'
                this.testMessage = '未配置主机地址'
                return
            }

            await new Promise<void>((resolve, reject) => {
                const socket = new Socket()
                const timeout = 8000
                let settled = false

                socket.setTimeout(timeout)
                socket.once('connect', () => {
                    if (settled) return
                    settled = true
                    socket.destroy()
                    resolve()
                })
                socket.once('timeout', () => {
                    if (settled) return
                    settled = true
                    socket.destroy()
                    reject(new Error(`连接超时 (${timeout / 1000}s)`))
                })
                socket.once('error', (err: Error) => {
                    if (settled) return
                    settled = true
                    reject(err)
                })
                socket.connect(port, host as string)
            })

            this.testResult = 'success'
            this.testMessage = `TCP ${this.profile.options.host}:${port} 连接成功`
        } catch (err: any) {
            this.testResult = 'fail'
            this.testMessage = err?.message ?? String(err)
        } finally {
            this.testing = false
        }
    }

    save () {
        if (!this.profileGroup) {
            this.profile.group = ''
        } else {
            this.profile.group = this.profileGroup.id
        }

        this.settingsComponentInstance?.save?.()
        this.profile.__cleanup()
        this.modalInstance.close(this.partialProfile)
    }

    cancel () {
        this.modalInstance.dismiss()
    }

    isConnectable (): boolean {
        return this.profileProvider instanceof ConnectableProfileProvider
    }

}
