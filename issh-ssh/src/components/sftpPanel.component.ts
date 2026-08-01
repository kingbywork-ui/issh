import { posix as path } from 'path'
import { Component, Input, Output, EventEmitter, Inject, Optional, ChangeDetectorRef, NgZone, OnDestroy } from '@angular/core'
import { FileUpload, DirectoryUpload, DirectoryDownload, MenuItemOptions, NotificationsService, PlatformService } from 'issh-core'
import { SFTPSession, SFTPFile } from '../session/sftp'
import { SSHSession } from '../session/ssh'
import { SFTPContextMenuItemProvider } from '../api'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { SFTPCreateDirectoryModalComponent } from './sftpCreateDirectoryModal.component'
import { Subscription } from 'rxjs'

interface PathSegment {
    name: string
    path: string
}

@Component({
    standalone: false,
    selector: 'sftp-panel',
    templateUrl: './sftpPanel.component.pug',
    styleUrls: ['./sftpPanel.component.scss'],
})
export class SFTPPanelComponent implements OnDestroy {
    @Input() session: SSHSession
    @Output() closed = new EventEmitter<void>()
    sftp: SFTPSession
    sftpDisconnected = false
    fileList: SFTPFile[]|null = null
    filteredFileList: SFTPFile[] = []
    @Input() path = '/'
    @Output() pathChange = new EventEmitter<string>()
    pathSegments: PathSegment[] = []
    @Input() cwdDetectionAvailable = false
    editingPath: string|null = null
    showFilter = false
    filterText = ''
    uploading = false
    activeUploads: {name: string, transfer: FileUpload, progress: number}[] = []
    private destroyed = false
    private navigationGeneration = 0
    private sftpSubscription = new Subscription()

    constructor (
        private ngbModal: NgbModal,
        private notifications: NotificationsService,
        public platform: PlatformService,
        private cd: ChangeDetectorRef,
        private ngZone: NgZone,
        @Optional() @Inject(SFTPContextMenuItemProvider) protected contextMenuProviders: SFTPContextMenuItemProvider[],
    ) {
        this.contextMenuProviders?.sort((a, b) => a.weight - b.weight)
    }

    async ngOnInit (): Promise<void> {
        try {
            await this.initSFTP()
            await this.navigate(this.path)
        } catch (error) {
            if (this.destroyed) {
                return
            }
            console.warn('Could not navigate to', this.path, ':', error)
            this.notifications.error(this.errorMessage(error))
            if (this.sftp && this.path !== '/') {
                await this.navigate('/')
            }
        } finally {
            this.detectChanges()
        }
    }

    private async initSFTP (): Promise<void> {
        const sftp = await this.session.openSFTP()
        if (this.destroyed) {
            await sftp.close()
            return
        }
        this.sftp = sftp
        this.sftpDisconnected = false
        this.sftpSubscription.add(sftp.closed$.subscribe(() => {
            this.handleSFTPClosed()
        }))
    }

    private sftpReconnectInProgress = false

    private async handleSFTPClosed (): Promise<void> {
        if (this.destroyed || this.sftpReconnectInProgress) {
            return
        }
        this.sftpReconnectInProgress = true
        try {
            this.notifications.info('SFTP 会话已断开，正在尝试重新连接…')
            this.sftpSubscription.unsubscribe()
            this.sftpSubscription = new Subscription()
            await this.initSFTP()
            await this.navigate(this.path)
            this.notifications.notice('SFTP 会话已重新连接')
        } catch (error) {
            this.sftpDisconnected = true
            this.notifications.error('SFTP 会话已断开，SSH 连接可能已丢失')
        } finally {
            this.sftpReconnectInProgress = false
            this.detectChanges()
        }
    }

    ngOnDestroy (): void {
        this.destroyed = true
        this.navigationGeneration++
        this.sftpSubscription.unsubscribe()
        for (const upload of this.activeUploads) {
            upload.transfer.cancel()
        }
        void this.sftp?.close().catch(() => null)
    }

    async navigate (newPath: string, fallbackOnError = true): Promise<void> {
        if (this.sftp?.isClosed) {
            this.sftpDisconnected = true
            return
        }
        const generation = ++this.navigationGeneration
        const previousPath = this.path
        this.path = newPath
        this.pathChange.next(this.path)

        this.clearFilter()

        let p = newPath
        this.pathSegments = []
        while (p !== '/') {
            this.pathSegments.unshift({
                name: path.basename(p),
                path: p,
            })
            p = path.dirname(p)
        }

        this.fileList = null
        this.filteredFileList = []
        try {
            const fileList = await this.sftp.readdir(this.path)
            if (!this.isCurrent(generation)) {
                return
            }
            this.fileList = fileList
        } catch (error) {
            if (this.isCurrent(generation)) {
                if (this.sftp?.isClosed || String(error).includes('session closed') || String(error).includes('Object has been destructed')) {
                    await this.handleSFTPClosed()
                    return
                }
                this.notifications.error(this.errorMessage(error))
                if (previousPath && fallbackOnError) {
                    await this.navigate(previousPath, false)
                }
            }
            return
        }

        const dirKey = a => a.isDirectory ? 1 : 0
        this.fileList.sort((a, b) =>
            dirKey(b) - dirKey(a) ||
            a.name.localeCompare(b.name))

        this.updateFilteredList()
    }

    getFileType (fileExtension: string): string {
        const codeExtensions = ['js', 'ts', 'py', 'java', 'cpp', 'h', 'cs', 'html', 'css', 'rb', 'php', 'swift', 'go', 'kt', 'sh', 'json', 'cc', 'c', 'xml']
        const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'bmp']
        const pdfExtensions = ['pdf']
        const archiveExtensions = ['zip', 'rar', 'tar', 'gz']
        const wordExtensions = ['doc', 'docx']
        const videoExtensions = ['mp4', 'avi', 'mkv', 'mov']
        const powerpointExtensions = ['ppt', 'pptx']
        const textExtensions = ['txt', 'log']
        const audioExtensions = ['mp3', 'wav', 'flac']
        const excelExtensions = ['xls', 'xlsx']

        const lowerCaseExtension = fileExtension.toLowerCase()

        if (codeExtensions.includes(lowerCaseExtension)) {
            return 'code'
        } else if (imageExtensions.includes(lowerCaseExtension)) {
            return 'image'
        } else if (pdfExtensions.includes(lowerCaseExtension)) {
            return 'pdf'
        } else if (archiveExtensions.includes(lowerCaseExtension)) {
            return 'archive'
        } else if (wordExtensions.includes(lowerCaseExtension)) {
            return 'word'
        } else if (videoExtensions.includes(lowerCaseExtension)) {
            return 'video'
        } else if (powerpointExtensions.includes(lowerCaseExtension)) {
            return 'powerpoint'
        } else if (textExtensions.includes(lowerCaseExtension)) {
            return 'text'
        } else if (audioExtensions.includes(lowerCaseExtension)) {
            return 'audio'
        } else if (excelExtensions.includes(lowerCaseExtension)) {
            return 'excel'
        } else {
            return 'unknown'
        }
    }

    getIcon (item: SFTPFile): string {
        if (item.isDirectory) {
            return 'fas fa-folder text-info'
        }
        if (item.isSymlink) {
            return 'fas fa-link text-warning'
        }
        const fileMatch = /\.([^.]+)$/.exec(item.name)
        const extension = fileMatch ? fileMatch[1] : null
        if (extension !== null) {
            const fileType = this.getFileType(extension)

            switch (fileType) {
                case 'unknown':
                    return 'fas fa-file'
                default:
                    return `fa-solid fa-file-${fileType} `
            }
        }
        return 'fas fa-file'
    }

    goUp (): void {
        this.navigate(path.dirname(this.path))
    }

    async open (item: SFTPFile): Promise<void> {
        try {
            if (item.isDirectory) {
                await this.navigate(item.fullPath)
            } else if (item.isSymlink) {
                const target = path.resolve(this.path, await this.sftp.readlink(item.fullPath))
                const stat = await this.sftp.stat(target)
                if (stat.isDirectory) {
                    await this.navigate(item.fullPath)
                } else {
                    await this.download(item.fullPath, stat.mode, stat.size)
                }
            } else {
                await this.download(item.fullPath, item.mode, item.size)
            }
        } catch (error) {
            if (!this.destroyed) {
                this.notifications.error(`Failed to open ${item.name}: ${this.errorMessage(error)}`)
            }
        } finally {
            this.detectChanges()
        }
    }

    async downloadItem (item: SFTPFile): Promise<void> {
        if (item.isDirectory) {
            await this.downloadFolder(item)
            return
        }

        if (item.isSymlink) {
            const target = path.resolve(this.path, await this.sftp.readlink(item.fullPath))
            const stat = await this.sftp.stat(target)
            if (stat.isDirectory) {
                await this.downloadFolder(item)
                return
            }
            await this.download(item.fullPath, stat.mode, stat.size)
            return
        }

        await this.download(item.fullPath, item.mode, item.size)
    }

    async openCreateDirectoryModal (): Promise<void> {
        const modal = this.ngbModal.open(SFTPCreateDirectoryModalComponent)
        const directoryName = await modal.result.catch(() => null)
        if (directoryName?.trim()) {
            this.sftp.mkdir(path.join(this.path, directoryName)).then(() => {
                this.notifications.notice('The directory was created successfully')
                this.navigate(path.join(this.path, directoryName))
            }).catch(() => {
                this.notifications.error('The directory could not be created')
            })
        }
    }

    async upload (): Promise<void> {
        await this.runUpload(async () => {
            const transfers = await this.platform.startUpload({ multiple: true })
            await this.ngZone.runOutsideAngular(() => Promise.all(transfers.map(t => this.uploadOne(t))))
        })
    }

    async uploadFolder (): Promise<void> {
        await this.runUpload(async () => {
            const transfer = await this.platform.startUploadDirectory()
            await this.ngZone.runOutsideAngular(() => this.uploadOneFolder(transfer))
        })
    }

    async onDropUpload (transfer: DirectoryUpload): Promise<void> {
        await this.runUpload(() => this.ngZone.runOutsideAngular(() => this.uploadOneFolder(transfer)))
    }

    async uploadOneFolder (transfer: DirectoryUpload, accumPath = ''): Promise<void> {
        const savedPath = this.path
        for(const t of transfer.getChildrens()) {
            if (t instanceof DirectoryUpload) {
                try {
                    await this.sftp.mkdir(path.posix.join(this.path, accumPath, t.getName()))
                } catch {
                    // Intentionally ignoring errors from making duplicate dirs.
                }
                await this.uploadOneFolder(t, path.posix.join(accumPath, t.getName()))
            } else {
                await this.uploadOneInner(t, path.posix.join(this.path, accumPath, t.getName()))
            }
        }
        if (this.path === savedPath) {
            this.ngZone.run(() => {
                if (!this.destroyed) {
                    void this.navigate(this.path)
                    this.detectChanges()
                }
            })
        }
    }

    async uploadOne (transfer: FileUpload): Promise<void> {
        await this.uploadOneInner(transfer, path.join(this.path, transfer.getName()))
    }

    private async uploadOneInner (transfer: FileUpload, remotePath: string): Promise<void> {
        const entry = { name: transfer.getName(), transfer, progress: 0 }
        this.ngZone.run(() => {
            if (this.destroyed) {
                transfer.cancel()
                return
            }
            this.activeUploads.push(entry)
            this.detectChanges()
        })

        const progressTimer = setInterval(() => {
            const size = transfer.getSize()
            if (size > 0) {
                entry.progress = Math.min(100, Math.round(100 * transfer.getCompletedBytes() / size))
            }
            this.ngZone.run(() => this.detectChanges())
        }, 200)

        try {
            await this.sftp.upload(remotePath, transfer)
        } finally {
            clearInterval(progressTimer)
            this.ngZone.run(() => {
                this.activeUploads = this.activeUploads.filter(x => x !== entry)
                this.detectChanges()
            })
        }
    }

    async download (itemPath: string, mode: number, size: number): Promise<void> {
        try {
            const transfer = await this.platform.startDownload(path.basename(itemPath), mode, size)
            if (!transfer || this.destroyed) {
                transfer?.cancel()
                return
            }
            await this.sftp.download(itemPath, transfer)
        } catch (error) {
            if (!this.destroyed) {
                this.notifications.error(`Failed to download ${path.basename(itemPath)}: ${this.errorMessage(error)}`)
            }
        } finally {
            this.detectChanges()
        }
    }

    async downloadFolder (folder: SFTPFile): Promise<void> {
        try {
            const transfer = await this.platform.startDownloadDirectory(folder.name, 0)
            if (!transfer) {
                return
            }

            // Start background size calculation and download simultaneously
            const sizeCalculationPromise = this.calculateFolderSizeAndUpdate(folder, transfer)
            const downloadPromise = this.downloadFolderRecursive(folder, transfer, '')

            try {
                await Promise.all([sizeCalculationPromise, downloadPromise])
                transfer.setStatus('')
                transfer.setCompleted(true)
            } catch (error) {
                transfer.cancel()
                throw error
            } finally {
                transfer.close()
            }
        } catch (error) {
            this.notifications.error(`Failed to download folder: ${error.message}`)
            throw error
        }
    }

    private async calculateFolderSizeAndUpdate (folder: SFTPFile, transfer: DirectoryDownload) {
        let totalSize = 0
        const items = await this.sftp.readdir(folder.fullPath)
        for (const item of items) {
            if (item.isDirectory) {
                totalSize += await this.calculateFolderSizeAndUpdate(item, transfer)
            } else {
                totalSize += item.size
            }
            transfer.setTotalSize(totalSize)
        }
        return totalSize
    }

    private async downloadFolderRecursive (folder: SFTPFile, transfer: DirectoryDownload, relativePath: string): Promise<void> {
        const items = await this.sftp.readdir(folder.fullPath)

        for (const item of items) {
            if (transfer.isCancelled()) {
                throw new Error('Download cancelled')
            }

            const itemRelativePath = relativePath ? `${relativePath}/${item.name}` : item.name

            transfer.setStatus(itemRelativePath)
            if (item.isDirectory) {
                await transfer.createDirectory(itemRelativePath)
                await this.downloadFolderRecursive(item, transfer, itemRelativePath)
            } else {
                const fileDownload = await transfer.createFile(itemRelativePath, item.mode, item.size)
                await this.sftp.download(item.fullPath, fileDownload)
            }
        }
    }

    async buildContextMenu (item: SFTPFile): Promise<MenuItemOptions[]> {
        let items: MenuItemOptions[] = []
        for (const section of await Promise.all((this.contextMenuProviders ?? []).map(x => x.getItems(item, this)))) {
            items.push({ type: 'separator' })
            items = items.concat(section)
        }
        return items.slice(1)
    }

    async showContextMenu (item: SFTPFile, event: MouseEvent): Promise<void> {
        event.preventDefault()
        this.platform.popupContextMenu(await this.buildContextMenu(item), event)
    }

    editPath (): void {
        this.editingPath = this.path
    }

    confirmPath (): void {
        if (this.editingPath === null) {
            return
        }
        this.navigate(this.editingPath)
        this.editingPath = null
    }

    close (): void {
        this.closed.emit()
    }

    clearFilter (): void {
        this.showFilter = false
        this.filterText = ''
        this.updateFilteredList()
    }

    onFilterChange (): void {
        this.updateFilteredList()
    }

    private updateFilteredList (): void {
        if (!this.fileList) {
            this.filteredFileList = []
            return
        }

        if (!this.showFilter || this.filterText.trim() === '') {
            this.filteredFileList = this.fileList
            return
        }

        this.filteredFileList = this.fileList.filter(item =>
            item.name.toLowerCase().includes(this.filterText.toLowerCase()),
        )
    }

    private async runUpload (operation: () => Promise<void>): Promise<void> {
        if (this.destroyed) {
            return
        }
        this.uploading = true
        this.detectChanges()
        try {
            await operation()
            if (!this.destroyed) {
                await this.navigate(this.path)
            }
        } catch (error) {
            if (!this.destroyed) {
                this.notifications.error(`Upload failed: ${this.errorMessage(error)}`)
            }
        } finally {
            if (!this.destroyed) {
                this.uploading = false
                this.detectChanges()
            }
        }
    }

    private isCurrent (generation: number): boolean {
        return !this.destroyed && generation === this.navigationGeneration
    }

    private detectChanges (): void {
        if (!this.destroyed) {
            this.cd.detectChanges()
        }
    }

    private errorMessage (error: unknown): string {
        return error instanceof Error ? error.message : String(error)
    }
}
