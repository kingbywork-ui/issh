import { Subject, Observable, Subscription } from 'rxjs'
import { SFTPStream, SFTPStreamDirectoryEntry, SFTPStreamStats } from 'ssh2-streams'
import * as russh from 'russh'

import type { SFTPBackend, SFTPBackendDirectoryEntry, SFTPBackendFile, SFTPBackendMetadata } from './sftp'

const SUDO_PASSWORD_MARKER = '[issh-sudo-password]'
const SUDO_READY_MARKER = '[issh-sudo-sftp-ready]'
const SUDO_AUTH_TIMEOUT_MS = 15000
const SFTP_CHUNK_SIZE = 32768
const SFTP_SERVER_COMMAND = [
    'sudo -k -S -p \'[issh-sudo-password]\' -- sh -c \'',
    'printf "[issh-sudo-sftp-ready]\\n" >&2; ',
    'for p in "$(command -v sftp-server 2>/dev/null)" ',
    '/usr/lib/openssh/sftp-server /usr/lib/ssh/sftp-server /usr/libexec/openssh/sftp-server; ',
    'do [ -n "$p" ] && [ -x "$p" ] && exec "$p"; done; ',
    'echo "No sftp-server executable found" >&2; exit 127\'',
].join('')

function callbackPromise<T> (start: (callback: (error: Error|null, value: T) => void) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => start((error, value) => error ? reject(error) : resolve(value)))
}

function voidCallbackPromise (start: (callback: (error?: Error|null) => void) => void): Promise<void> {
    return new Promise<void>((resolve, reject) => start(error => error ? reject(error) : resolve()))
}

class SudoSFTPFile implements SFTPBackendFile {
    private position = 0
    private closed = false

    constructor (private stream: SFTPStream, private handle: Buffer) { }

    async read (requestedBytes: number): Promise<Uint8Array> {
        this.assertOpen()
        const buffer = Buffer.alloc(Math.min(requestedBytes, SFTP_CHUNK_SIZE))
        const result = await new Promise<{bytesRead: number, buffer: Buffer}>((resolve, reject) => {
            this.stream.readData(this.handle, buffer, 0, buffer.length, this.position, (error, bytesRead, data) => {
                if (error) {
                    if ((error as any).code === 1) {
                        resolve({ bytesRead: 0, buffer })
                    } else {
                        reject(error)
                    }
                } else {
                    resolve({ bytesRead, buffer: data })
                }
            })
        })
        this.position += result.bytesRead
        return result.buffer.subarray(0, result.bytesRead)
    }

    async writeAll (data: Uint8Array): Promise<void> {
        this.assertOpen()
        const buffer = Buffer.from(data)
        for (let offset = 0; offset < buffer.length; offset += SFTP_CHUNK_SIZE) {
            const length = Math.min(SFTP_CHUNK_SIZE, buffer.length - offset)
            await voidCallbackPromise(callback => {
                this.stream.writeData(this.handle, buffer, offset, length, this.position, callback)
            })
            this.position += length
        }
    }

    async flush (): Promise<void> { }

    async shutdown (): Promise<void> {
        if (this.closed) {
            return
        }
        this.closed = true
        await voidCallbackPromise(callback => this.stream.close(this.handle, callback))
    }

    private assertOpen (): void {
        if (this.closed) {
            throw new Error('SFTP file handle is closed')
        }
    }
}

export class SudoSFTPBackend implements SFTPBackend {
    get closed$ (): Observable<void> { return this.closed.asObservable() }
    private closed = new Subject<void>()
    private subscriptions = new Subscription()
    private closePromise: Promise<void>|null = null
    private writeChain = Promise.resolve()
    private closedEmitted = false

    private constructor (private stream: SFTPStream, private channel: russh.Channel) {
        this.stream.on('data', (data: Buffer) => {
            this.writeChain = this.writeChain.then(() => this.channel.write(data)).catch(error => {
                this.stream.destroy(error)
            })
        })
        this.stream.on('error', () => this.emitClosed())
        this.subscriptions.add(this.channel.data$.subscribe(data => this.stream.write(Buffer.from(data))))
        this.subscriptions.add(this.channel.eof$.subscribe(() => this.stream.end()))
        this.subscriptions.add(this.channel.closed$.subscribe(() => this.emitClosed()))
    }

    static async connect (ssh: russh.AuthenticatedSSHClient, password: string): Promise<SudoSFTPBackend> {
        const channel = await ssh.activateChannel(await ssh.openSessionChannel())
        let stderr = ''
        let passwordSent = false
        let resolveReady: (() => void)|null = null
        let rejectReady: ((error: Error) => void)|null = null
        const ready = new Promise<void>((resolve, reject) => {
            resolveReady = resolve
            rejectReady = reject
        })
        const authSubscription = new Subscription()
        const timer = setTimeout(() => rejectReady?.(new Error('Timed out while validating the sudo password')), SUDO_AUTH_TIMEOUT_MS)

        authSubscription.add(channel.extendedData$.subscribe(async ([, data]) => {
            stderr += Buffer.from(data).toString('utf8')
            if (stderr.includes(SUDO_PASSWORD_MARKER)) {
                stderr = stderr.replace(SUDO_PASSWORD_MARKER, '')
                if (passwordSent) {
                    rejectReady?.(new Error('sudo password verification failed'))
                    return
                }
                passwordSent = true
                await channel.write(Buffer.from(password + '\n', 'utf8'))
            }
            if (stderr.includes(SUDO_READY_MARKER)) {
                resolveReady?.()
            }
        }))
        authSubscription.add(channel.closed$.subscribe(() => {
            rejectReady?.(new Error(stderr.trim() || 'sudo SFTP process exited before startup'))
        }))

        try {
            await channel.requestExec(SFTP_SERVER_COMMAND)
            await ready
        } catch (error) {
            await channel.close().catch(() => null)
            throw error
        } finally {
            clearTimeout(timer)
            authSubscription.unsubscribe()
        }

        const stream = new SFTPStream()
        const backend = new SudoSFTPBackend(stream, channel)
        await new Promise<void>((resolve, reject) => {
            const readyTimer = setTimeout(() => reject(new Error('Timed out while starting sudo SFTP')), SUDO_AUTH_TIMEOUT_MS)
            stream.once('ready', () => {
                clearTimeout(readyTimer)
                resolve()
            })
            stream.once('error', error => {
                clearTimeout(readyTimer)
                reject(error)
            })
            backend.closed$.subscribe(() => {
                clearTimeout(readyTimer)
                reject(new Error('sudo SFTP channel closed during startup'))
            })
        })
        return backend
    }

    async readDirectory (path: string): Promise<SFTPBackendDirectoryEntry[]> {
        const entries = await callbackPromise<SFTPStreamDirectoryEntry[]>(callback => this.stream.readdir(path, callback))
        return entries.map(entry => ({ name: entry.filename, metadata: this.metadata(entry.attrs) }))
    }

    async stat (path: string): Promise<SFTPBackendMetadata> {
        return this.metadata(await callbackPromise<SFTPStreamStats>(callback => this.stream.stat(path, callback)))
    }

    readlink (path: string): Promise<string> {
        return callbackPromise<string>(callback => this.stream.readlink(path, callback))
    }

    createDirectory (path: string): Promise<void> {
        return voidCallbackPromise(callback => this.stream.mkdir(path, callback))
    }

    rename (source: string, destination: string): Promise<void> {
        return voidCallbackPromise(callback => this.stream.rename(source, destination, callback))
    }

    chmod (path: string, mode: string|number): Promise<void> {
        const parsed = typeof mode === 'string' ? parseInt(mode, 8) : mode
        return voidCallbackPromise(callback => this.stream.chmod(path, parsed, callback))
    }

    removeDirectory (path: string): Promise<void> {
        return voidCallbackPromise(callback => this.stream.rmdir(path, callback))
    }

    removeFile (path: string): Promise<void> {
        return voidCallbackPromise(callback => this.stream.unlink(path, callback))
    }

    async open (path: string, mode: number): Promise<SFTPBackendFile> {
        const handle = await callbackPromise<Buffer>(callback => this.stream.open(path, mode, callback))
        return new SudoSFTPFile(this.stream, handle)
    }

    close (): Promise<void> {
        if (!this.closePromise) {
            this.closePromise = (async () => {
                this.stream.end()
                await this.writeChain.catch(() => null)
                await this.channel.close().catch(() => null)
                this.emitClosed()
            })()
        }
        return this.closePromise
    }

    private metadata (stats: SFTPStreamStats): SFTPBackendMetadata {
        return {
            type: stats.isDirectory()
                ? russh.SFTPFileType.Directory
                : stats.isSymbolicLink() ? russh.SFTPFileType.Symlink : russh.SFTPFileType.File,
            size: stats.size ?? 0,
            uid: stats.uid,
            gid: stats.gid,
            permissions: stats.mode,
            atime: stats.atime,
            mtime: stats.mtime,
        }
    }

    private emitClosed (): void {
        if (this.closedEmitted) {
            return
        }
        this.closedEmitted = true
        this.subscriptions.unsubscribe()
        this.closed.next()
        this.closed.complete()
    }
}
