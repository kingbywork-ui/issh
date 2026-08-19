declare module 'ssh2-streams' {
    import { Transform } from 'stream'

    export class SFTPStream extends Transform {
        constructor (config?: { highWaterMark?: number })
        open (path: string, flags: number, callback: (error: Error|null, handle: Buffer) => void): boolean
        close (handle: Buffer, callback: (error?: Error|null) => void): boolean
        readData (handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, callback: (error: Error|null, bytesRead: number, buffer: Buffer) => void): boolean
        writeData (handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, callback: (error?: Error|null) => void): boolean
        readdir (path: string, callback: (error: Error|null, entries: SFTPStreamDirectoryEntry[]) => void): boolean
        stat (path: string, callback: (error: Error|null, stats: SFTPStreamStats) => void): boolean
        readlink (path: string, callback: (error: Error|null, target: string) => void): boolean
        mkdir (path: string, callback: (error?: Error|null) => void): boolean
        rename (source: string, destination: string, callback: (error?: Error|null) => void): boolean
        chmod (path: string, mode: number, callback: (error?: Error|null) => void): boolean
        rmdir (path: string, callback: (error?: Error|null) => void): boolean
        unlink (path: string, callback: (error?: Error|null) => void): boolean
    }

    export interface SFTPStreamStats {
        size?: number
        uid?: number
        gid?: number
        mode?: number
        atime?: number
        mtime?: number
        isDirectory (): boolean
        isSymbolicLink (): boolean
    }

    export interface SFTPStreamDirectoryEntry {
        filename: string
        attrs: SFTPStreamStats
    }
}
