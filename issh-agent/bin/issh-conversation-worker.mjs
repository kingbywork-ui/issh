import readline from 'node:readline'
import { ConversationService } from '../src/conversation-service.mjs'

if (!process.argv[2]) throw new Error('Conversation data file is required')
const service = new ConversationService(process.argv[2])
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', line => {
    let request
    try {
        if (Buffer.byteLength(line) > 256 * 1024) throw new Error('请求过大')
        request = JSON.parse(line)
        const result = service.call(request.method, request.params, request.registry)
        process.stdout.write(JSON.stringify({ id: request.id, result }) + '\n')
    } catch (error) {
        process.stdout.write(JSON.stringify({ id: request?.id, error: { message: error.message } }) + '\n')
    }
})
lines.on('close', () => { service.close(); process.exit(0) })
