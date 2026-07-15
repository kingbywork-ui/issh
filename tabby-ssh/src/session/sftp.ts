/* eslint-disable @typescript-eslint/no-unused-vars */
import { Subject, Observable } from 'rxjs'
import { posix as posixPath } from 'path'
import { Injector } from '@angular/core'
import { FileDownload, FileUpload, Logger, LogService } from 'tabby-core'
import * as russh from 'russh'

export interface SFTPFile {
    name: string
    fullPath: string
    isDirectory: boolean
    isSymlink: boolean
    mode: number
    size: number
    modified: Date
}

export class SFTPFileHandle {
    position = 0

    constructor (
        private inner: russh.SFTPFile|null,
    ) { }

    async read (): Promise<Uint8Array> {
        if (!this.inner) {
            return Promise.resolve(new Uint8Array(0))
        }
        return this.inner.read(256 * 1024)
    }

    async write (chunk: Uint8Array): Promise<void> {
        if (!this.inner) {
            throw new Error('File handle is closed')
        }
        await this.inner.writeAll(chunk)
    }

    async close (): Promise<void> {
        await this.inner?.shutdown()
        this.inner = null
    }

    async flush (): Promise<void> {
        if (!this.inner) {
            throw new Error('File handle is closed')
        }
        await this.inner.flush()
    }
}

export class SFTPSession {
    get closed$ (): Observable<void> { return this.closed }
    private closed = new Subject<void>()
    private logger: Logger
    private closePromise: Promise<void>|null = null
    private closedEmitted = false

    constructor (private sftp: russh.SFTP, injector: Injector) {
        this.logger = injector.get(LogService).create('sftp')
        sftp.closed$.subscribe(() => this.emitClosed())
    }

    async readdir (p: string): Promise<SFTPFile[]> {
        this.logger.debug('readdir', p)
        const entries = await this.sftp.readDirectory(p)
        return entries.map(entry => this._makeFile(
            posixPath.join(p, entry.name), entry,
        ))
    }

    readlink (p: string): Promise<string> {
        this.logger.debug('readlink', p)
        return this.sftp.readlink(p)
    }

    /**
     * Resolves symlinks using the SFTP v3 operations exposed by russh.
     * russh does not currently expose SSH_FXP_REALPATH.
     */
    async canonicalize (p: string): Promise<string> {
        let pending = posixPath.resolve('/', p).split('/').filter(Boolean)
        const resolved: string[] = []
        let symlinkCount = 0

        while (pending.length) {
            const segment = pending.shift()!
            const candidate = '/' + [...resolved, segment].join('/')
            let target: string
            try {
                target = await this.readlink(candidate)
            } catch {
                resolved.push(segment)
                continue
            }

            if (++symlinkCount > 40) {
                throw new Error(`Too many symbolic links while resolving ${p}`)
            }
            const targetPath = target.startsWith('/')
                ? posixPath.resolve('/', target)
                : posixPath.resolve('/' + resolved.join('/'), target)
            pending = [...targetPath.split('/').filter(Boolean), ...pending]
            resolved.length = 0
        }

        const result = '/' + resolved.join('/')
        await this.sftp.stat(result)
        return result
    }

    realpath (p: string): Promise<string> {
        return this.canonicalize(p)
    }

    async stat (p: string): Promise<SFTPFile> {
        this.logger.debug('stat', p)
        const stats = await this.sftp.stat(p)
        return {
            name: posixPath.basename(p),
            fullPath: p,
            isDirectory: stats.type === russh.SFTPFileType.Directory,
            isSymlink: stats.type === russh.SFTPFileType.Symlink,
            mode: stats.permissions ?? 0,
            size: stats.size,
            modified: new Date((stats.mtime ?? 0) * 1000),
        }
    }

    async open (p: string, mode: number): Promise<SFTPFileHandle> {
        this.logger.debug('open', p, mode)
        const handle = await this.sftp.open(p, mode)
        return new SFTPFileHandle(handle)
    }

    async rmdir (p: string): Promise<void> {
        await this.sftp.removeDirectory(p)
    }

    async mkdir (p: string): Promise<void> {
        await this.sftp.createDirectory(p)
    }

    async rename (oldPath: string, newPath: string): Promise<void> {
        this.logger.debug('rename', oldPath, newPath)
        await this.sftp.rename(oldPath, newPath)
    }

    close (): Promise<void> {
        if (!this.closePromise) {
            this.closePromise = this.sftp.close().finally(() => this.emitClosed())
        }
        return this.closePromise
    }

    async unlink (p: string): Promise<void> {
        await this.sftp.removeFile(p)
    }

    async chmod (p: string, mode: string|number): Promise<void> {
        this.logger.debug('chmod', p, mode)
        await this.sftp.chmod(p, mode)
    }

    async upload (path: string, transfer: FileUpload): Promise<void> {
        this.logger.info('Uploading into', path)
        const tempPath = await this.makeUploadTempPath(path)
        let handle: SFTPFileHandle|null = null
        try {
            handle = await this.open(tempPath, russh.OPEN_WRITE | russh.OPEN_CREATE | russh.OPEN_TRUNCATE)
            while (true) {
                const chunk = await transfer.read()
                if (!chunk.length) {
                    break
                }
                await handle.write(chunk)
            }
            await handle.flush()
            await handle.close()
            handle = null
            // Never unlink the destination first. Servers which implement overwrite
            // rename do the replacement atomically; other servers reject this call
            // and leave the original destination intact.
            await this.rename(tempPath, path)
            transfer.close()
        } catch (e) {
            transfer.cancel()
            throw e
        } finally {
            await handle?.close().catch(() => null)
            await this.unlink(tempPath).catch(() => null)
        }
    }

    async download (path: string, transfer: FileDownload): Promise<void> {
        this.logger.info('Downloading', path)
        let handle: SFTPFileHandle|null = null
        try {
            handle = await this.open(path, russh.OPEN_READ)
            while (true) {
                const chunk = await handle.read()
                if (!chunk.length) {
                    break
                }
                await transfer.write(chunk)
            }
            await handle.close()
            handle = null
            transfer.close()
        } catch (e) {
            transfer.cancel()
            throw e
        } finally {
            await handle?.close().catch(() => null)
        }
    }

    private _makeFile (p: string, entry: russh.SFTPDirectoryEntry): SFTPFile {
        return {
            fullPath: p,
            name: posixPath.basename(p),
            isDirectory: entry.metadata.type === russh.SFTPFileType.Directory,
            isSymlink: entry.metadata.type === russh.SFTPFileType.Symlink,
            mode: entry.metadata.permissions ?? 0,
            size: entry.metadata.size,
            modified: new Date((entry.metadata.mtime ?? 0) * 1000),
        }
    }

    private async makeUploadTempPath (targetPath: string): Promise<string> {
        const directory = posixPath.dirname(targetPath)
        const basename = posixPath.basename(targetPath)
        for (let attempt = 0; attempt < 20; attempt++) {
            const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
            const candidate = posixPath.join(directory, `.${basename}.tabby-upload-${nonce}`)
            try {
                await this.sftp.stat(candidate)
            } catch {
                return candidate
            }
        }
        throw new Error(`Could not allocate a unique upload temporary file for ${targetPath}`)
    }

    private emitClosed (): void {
        if (this.closedEmitted) {
            return
        }
        this.closedEmitted = true
        this.closed.next()
        this.closed.complete()
    }
}
