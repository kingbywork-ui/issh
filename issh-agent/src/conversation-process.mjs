import { spawn } from 'node:child_process'
import { JsonLinePeer, PiRpcPeer, ConversationAdapter } from './conversation-adapters.mjs'

// Explicit executable and argv only. A future runtime SSH exec channel can
// supply the same readable/writable pair without spawning a local process.
export function startConversationProcess ({ executable, args, cwd, kind, timeoutMs = 60000 }) {
    if (typeof executable !== 'string' || !executable || !Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
        throw new Error('Explicit executable and argument array are required')
    }
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const peer = kind === 'pi'
        ? new PiRpcPeer(child.stdout, child.stdin, { timeoutMs })
        : new JsonLinePeer(child.stdout, child.stdin, { timeoutMs })
    // Drain stderr without copying credentials or provider logs into transcripts.
    child.stderr.resume()
    child.on('error', () => peer.close(new Error('Unable to start Agent process')))
    child.on('exit', () => peer.close(new Error('Agent process closed')))
    peer.on('closed', () => { if (child.exitCode === null) child.kill() })
    return { adapter: new ConversationAdapter(kind, peer), peer, close: () => peer.close() }
}
