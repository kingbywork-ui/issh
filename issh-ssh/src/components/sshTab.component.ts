import * as russh from 'russh'
import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import colors from 'ansi-colors'
import { Component, Injector, } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { Platform, ProfilesService, PromptModalComponent } from 'issh-core'
import { BaseTerminalTabComponent, ConnectableTerminalTabComponent, XTermFrontend } from 'issh-terminal'
import { SSHService } from '../services/ssh.service'
import { KeyboardInteractivePrompt, SSHSession } from '../session/ssh'
import { SSHPortForwardingModalComponent } from './sshPortForwardingModal.component'
import { SSHProfile } from '../api'
import { SSHShellSession } from '../session/shell'
import { SSHMultiplexerService } from '../services/sshMultiplexer.service'
import { SSHAppPanelService } from '../services/sshAppPanel.service'

/** @hidden */
@Component({
    standalone: false,
    selector: 'ssh-tab',
    template: require('./sshTab.component.pug'),
    styles: [
        ...BaseTerminalTabComponent.styles,
        require('./sshTab.component.scss'),
    ],
    animations: [
        ...BaseTerminalTabComponent.animations,
    ],
})
export class SSHTabComponent extends ConnectableTerminalTabComponent<SSHProfile> {
    Platform = Platform
    sshSession: SSHSession|null = null
    session: SSHShellSession|null = null
    sftpPanelVisible = false
    sendPanelVisible = false
    sftpPath = '/'
    sftpSudoMode = false
    sftpSudoPassword: string|null = null
    private sudoSftpShellInput = ''
    private sftpLoginDirectory: string|null = null
    enableToolbar = true
    activeKIPrompt: KeyboardInteractivePrompt|null = null

    constructor (
        injector: Injector,
        public ssh: SSHService,
        private ngbModal: NgbModal,
        private profilesService: ProfilesService,
        private sshMultiplexer: SSHMultiplexerService,
        private sshAppPanel: SSHAppPanelService,
    ) {
        super(injector)
        this.sessionChanged$.subscribe(() => {
            this.activeKIPrompt = null
            if (this.session?.open) {
                this.sshAppPanel.syncFromTab(this)
            }
        })
    }

    ngOnInit (): void {
        this.sshAppPanel.registerTab(this)
        this.subscribeUntilDestroyed(this.hotkeys.hotkey$, hotkey => {
            if (!this.hasFocus) {
                return
            }
            switch (hotkey) {
                case 'home':
                    this.sendInput('\x1bOH' )
                    break
                case 'end':
                    this.sendInput('\x1bOF' )
                    break
                case 'restart-ssh-session':
                    this.reconnect()
                    break
                case 'launch-winscp':
                    if (this.sshSession) {
                        this.ssh.launchWinSCP(this.sshSession)
                    }
                    break
                case 'open-sftp':
                    this.openSFTP()
                    break
            }
        })

        super.ngOnInit()
    }

    ngOnDestroy (): void {
        this.sshAppPanel.unregisterTab(this)
        super.ngOnDestroy()
    }

    toggleSendPanel (): void {
        this.sendPanelVisible = !this.sendPanelVisible
        this.sshAppPanel.syncFromTab(this)
        this.requestTerminalResize()
    }

    onSendPanelClosed (): void {
        this.sendPanelVisible = false
        this.sshAppPanel.syncFromTab(this)
        this.requestTerminalResize()
    }

    onSftpPanelClosed (): void {
        this.sftpPanelVisible = false
        this.sftpSudoMode = false
        this.sftpSudoPassword = null
        this.sshAppPanel.syncFromTab(this)
        this.requestTerminalResize()
    }

    private requestTerminalResize (): void {
        setTimeout(() => {
            window.dispatchEvent(new Event('resize'))
        }, 50)
        setTimeout(() => {
            window.dispatchEvent(new Event('resize'))
        }, 200)
    }

    async setupOneSession (injector: Injector, profile: SSHProfile, multiplex = true): Promise<SSHSession> {
        let session = await this.sshMultiplexer.getSession(profile)
        if (!multiplex || !session || !profile.options.reuseSession) {
            session = new SSHSession(injector, profile)

            if (profile.options.jumpHost) {
                const jumpConnection = (await this.profilesService.getProfiles()).find(x => x.id === profile.options.jumpHost)

                if (!jumpConnection) {
                    throw new Error(`${profile.options.host}: jump host "${profile.options.jumpHost}" not found in your config`)
                }

                const jumpSession = await this.setupOneSession(
                    this.injector,
                    this.profilesService.getConfigProxyForProfile<SSHProfile>(jumpConnection),
                )

                jumpSession.ref()
                session.willDestroy$.subscribe(() => jumpSession.unref())
                jumpSession.willDestroy$.subscribe(() => {
                    if (session?.open) {
                        session.destroy()
                    }
                })

                if (!(jumpSession.ssh instanceof russh.AuthenticatedSSHClient)) {
                    throw new Error('Jump session is not authenticated yet somehow')
                }

                try {
                    session.jumpChannel = await jumpSession.ssh.openTCPForwardChannel({
                        addressToConnectTo: profile.options.host,
                        portToConnectTo: profile.options.port ?? 22,
                        originatorAddress: '127.0.0.1',
                        originatorPort: 0,
                    })
                } catch (err) {
                    jumpSession.emitServiceMessage(colors.bgRed.black(' X ') + ` Could not set up port forward on ${jumpConnection.name}`)
                    throw err
                }
            }
        }

        this.attachSessionHandler(session.serviceMessage$, msg => {
            msg = msg.replace(/\n/g, '\r\n      ')
            this.write(`\r${colors.black.bgWhite(' SSH ')} ${msg}\r\n`)
        })

        this.attachSessionHandler(session.willDestroy$, () => {
            this.activeKIPrompt = null
        })

        this.attachSessionHandler(session.keyboardInteractivePrompt$, prompt => {
            this.activeKIPrompt = prompt
            setTimeout(() => {
                this.frontend?.scrollToBottom()
            })
        })

        if (!session.open) {
            this.write('\r\n' + colors.black.bgWhite(' SSH ') + ` Connecting to ${session.profile.name}\r\n`)

            this.startSpinner(this.translate.instant(_('Connecting')))

            try {
                await session.start()
            } finally {
                this.stopSpinner()
            }

            this.sshMultiplexer.addSession(session)
        }

        return session
    }

    protected onSessionDestroyed (): void {
        if (this.frontend) {
            // Session was closed abruptly
            this.write('\r\n' + colors.black.bgWhite(' SSH ') + ` ${this.sshSession?.profile.options.host}: session closed\r\n`)

            super.onSessionDestroyed()
        }
    }

    private async initializeSessionMaybeMultiplex (multiplex = true): Promise<void> {
        this.sftpLoginDirectory = null
        this.sshSession = await this.setupOneSession(this.injector, this.profile, multiplex)
        const session = new SSHShellSession(this.injector, this.sshSession, this.profile)

        this.setSession(session)
        this.sudoSftpShellInput = ''
        this.attachSessionHandler(session.middleware.outputToSession$, data => {
            this.handleSudoSFTPShellInput(data)
        })
        this.attachSessionHandler(session.serviceMessage$, msg => {
            msg = msg.replace(/\n/g, '\r\n      ')
            this.write(`\r${colors.black.bgWhite(' SSH ')} ${msg}\r\n`)
            session.resize(this.size.columns, this.size.rows)
        })

        await session.start()

        this.session?.resize(this.size.columns, this.size.rows)

        if (this.session?.open) {
            this.sshAppPanel.syncFromTab(this)
        }
    }

    async initializeSession (): Promise<void> {
        await super.initializeSession()
        try {
            await this.initializeSessionMaybeMultiplex(true)
        } catch {
            try {
                await this.initializeSessionMaybeMultiplex(false)
            } catch (e) {
                console.error('SSH session initialization failed', e)
                this.write(colors.black.bgRed(' X ') + ' ' + colors.red(e.message) + '\r\n')
                return
            }
        }
    }

    showPortForwarding (): void {
        const modal = this.ngbModal.open(SSHPortForwardingModalComponent).componentInstance as SSHPortForwardingModalComponent
        modal.session = this.sshSession!
    }

    async canClose (): Promise<boolean> {
        if (!this.session?.open) {
            return true
        }
        if (!(this.profile.options.warnOnClose ?? this.config.store.ssh.warnOnClose)) {
            return true
        }
        return (await this.platform.showMessageBox(
            {
                type: 'warning',
                message: this.translate.instant(_('Disconnect from {host}?'), this.profile.options),
                buttons: [
                    this.translate.instant(_('Disconnect')),
                    this.translate.instant(_('Do not close')),
                ],
                defaultId: 0,
                cancelId: 1,
            },
        )).response === 0
    }

    async openSFTP (): Promise<void> {
        this.sftpPath = await this.resolveSFTPInitialPath()
        this.sftpSudoMode = false
        this.sftpSudoPassword = null
        const authenticatedAsRoot = this.sshSession?.authUsername === 'root'
        const rootDirectory = this.sftpPath === '/root' || this.sftpPath.startsWith('/root/')
        if (rootDirectory && !authenticatedAsRoot) {
            const response = await this.platform.showMessageBox({
                type: 'warning',
                message: this.translate.instant(_('当前 SSH 使用普通用户，但终端位于 root 目录。是否使用 sudo SFTP 模式？')),
                detail: this.translate.instant(_('sudo SFTP 将验证 sudo/root 密码，并以 root 权限打开当前目录。')),
                buttons: [
                    this.translate.instant(_('使用 sudo SFTP')),
                    this.translate.instant(_('使用普通 SFTP')),
                    this.translate.instant(_('取消')),
                ],
                defaultId: 0,
                cancelId: 2,
            })
            if (response.response === 2) {
                return
            }
            if (response.response === 0) {
                const modal = this.ngbModal.open(PromptModalComponent)
                modal.componentInstance.prompt = this.translate.instant(_('请输入 {user}@{host} 的 sudo/root 密码'), {
                    user: this.sshSession?.authUsername,
                    host: this.profile.options.host,
                })
                modal.componentInstance.password = true
                const result = await modal.result.catch(() => null)
                if (!result?.value) {
                    return
                }
                this.sftpSudoMode = true
                this.sftpSudoPassword = result.value
            }
        }
        setTimeout(() => {
            this.sftpPanelVisible = true
            this.sshAppPanel.syncFromTab(this)
            this.requestTerminalResize()
        }, 100)
    }

    private async resolveSFTPInitialPath (): Promise<string> {
        const reportedDirectory = await this.session?.getWorkingDirectory()
        if (reportedDirectory?.startsWith('/')) {
            return reportedDirectory
        }

        const terminalDirectory = this.getWorkingDirectoryFromTerminal()
        if (terminalDirectory) {
            if (terminalDirectory === '~' || terminalDirectory.startsWith('~/')) {
                const home = await this.getSFTPLoginDirectory()
                if (home) {
                    return home + terminalDirectory.slice(1)
                }
            }
            return terminalDirectory
        }

        const loginDirectory = await this.getSFTPLoginDirectory()
        if (loginDirectory) {
            return loginDirectory
        }

        const username = this.sshSession?.authUsername
        return username === 'root' ? '/root' : username ? `/home/${username}` : '/'
    }

    private async getSFTPLoginDirectory (): Promise<string|null> {
        if (!this.sftpLoginDirectory) {
            const output = await this.sshSession?.runReadonlyCommand('pwd', 2000)
            this.sftpLoginDirectory = output
                ?.split(/\r?\n/)
                .map(line => line.trim())
                .reverse()
                .find(line => line.startsWith('/')) ?? null
        }
        return this.sftpLoginDirectory
    }

    private getWorkingDirectoryFromTerminal (): string|null {
        if (!(this.frontend instanceof XTermFrontend)) {
            return null
        }
        const buffer = this.frontend.xterm.buffer.active
        const lastRow = buffer.baseY + buffer.cursorY
        const lines: string[] = []
        for (let row = Math.max(0, lastRow - 100); row <= lastRow; row++) {
            lines.push(buffer.getLine(row)?.translateToString(true).trim() ?? '')
        }

        for (let index = lines.length - 2; index > 0; index--) {
            const candidate = lines[index]
            if (candidate.startsWith('/') && /(?:^|[#$>%]\s*)pwd\s*$/.test(lines[index - 1])) {
                return candidate
            }
        }

        const prompt = lines[lines.length - 1] ?? ''
        const bracketPrompt = /\[[^\]]*\s((?:\/|~)[^\]]*)\][#$]\s*$/.exec(prompt)
        if (bracketPrompt) {
            return bracketPrompt[1]
        }
        const colonPrompt = /@[^:\s]+:((?:\/|~)[^#$]*?)[#$]\s*$/.exec(prompt)
        return colonPrompt?.[1]?.trim() ?? null
    }

    private handleSudoSFTPShellInput (data: Buffer): void {
        if (!this.sftpPanelVisible || !this.sftpSudoMode || this.alternateScreenActive) {
            return
        }
        for (const char of data.toString('utf8')) {
            if (char === '\x04') {
                this.forceCloseSudoSFTP()
                return
            }
            if (char === '\x7f' || char === '\b') {
                this.sudoSftpShellInput = this.sudoSftpShellInput.slice(0, -1)
                continue
            }
            if (char === '\r' || char === '\n') {
                const command = this.sudoSftpShellInput.trim()
                this.sudoSftpShellInput = ''
                if (/^(?:exit(?:\s+\d+)?|logout)$/.test(command)) {
                    this.forceCloseSudoSFTP()
                    return
                }
                continue
            }
            if (char >= ' ') {
                this.sudoSftpShellInput += char
                this.sudoSftpShellInput = this.sudoSftpShellInput.slice(-256)
            }
        }
    }

    private forceCloseSudoSFTP (): void {
        if (!this.sftpPanelVisible || !this.sftpSudoMode) {
            return
        }
        this.sftpPanelVisible = false
        this.sftpSudoMode = false
        this.sftpSudoPassword = null
        this.sudoSftpShellInput = ''
        this.sshAppPanel.syncFromTab(this)
        this.requestTerminalResize()
        this.notifications.notice(this.translate.instant(_('已退出 root，sudo SFTP 会话已断开')))
    }

    protected isSessionExplicitlyTerminated (): boolean {
        return super.isSessionExplicitlyTerminated() ||
        this.session?.remoteEOFReceived === true ||
        this.recentInputs.charCodeAt(this.recentInputs.length - 1) === 4 ||
        this.recentInputs.endsWith('exit\r')
    }
}
