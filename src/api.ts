import Fastify from 'fastify'
import { baseUrl, config, ensureDirs } from './config.js'
import {
    chatCoverage,
    enqueueSyncRequest,
    getChat,
    getMessage,
    getMeta,
    getTranscript,
    globalStats,
    listChats,
    listMessages,
    type MessageRow,
    oldestMessage,
    saveTranscript
} from './db.js'
import { DeepgramNotConfigured, transcribe } from './deepgram.js'
import { materializeMedia, MediaUnavailable, mimeFor, openMediaStream, readMediaBytes } from './media.js'

ensureDirs()

const app = Fastify({ logger: false })

app.addHook('onRequest', async (request, reply) => {
    if (!config.apiKey || request.url.startsWith('/health')) return
    if (request.headers['x-api-key'] !== config.apiKey) {
        await reply.code(401).send({ error: 'unauthorized', detail: 'falta o no coincide el header x-api-key' })
    }
})

// --- helpers -------------------------------------------------------------

/**
 * Acepta ISO 8601 completo (preferido: lleva zona horaria explicita) o `YYYY-MM-DD`,
 * que se interpreta en UTC — inicio del dia para `from`, fin del dia para `to`.
 */
function parseInstant(value: string | undefined, edge: 'start' | 'end'): number | null {
    if (!value) return null
    const bare = /^\d{4}-\d{2}-\d{2}$/.test(value)
    const iso = bare ? `${value}T${edge === 'start' ? '00:00:00.000Z' : '23:59:59.999Z'}` : value
    const ms = Date.parse(iso)
    if (Number.isNaN(ms)) throw new Error(`fecha invalida: "${value}"`)
    return Math.floor(ms / 1000)
}

function boolParam(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined) return fallback
    return value === 'true' || value === '1'
}

function intParam(value: string | undefined, fallback: number, max: number): number {
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) return fallback
    return Math.min(Math.floor(n), max)
}

const iso = (seconds: number): string => new Date(seconds * 1000).toISOString()

/** Ejecuta `worker` sobre los items con un tope de concurrencia. */
async function mapPool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length)
    let cursor = 0
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const index = cursor++
            results[index] = await worker(items[index] as T)
        }
    })
    await Promise.all(runners)
    return results
}

// --- health --------------------------------------------------------------

app.get('/health', async () => {
    const heartbeat = Number(getMeta('daemon_heartbeat') ?? 0)
    const ageSeconds = heartbeat > 0 ? Math.floor(Date.now() / 1000) - heartbeat : null
    const stats = globalStats()

    return {
        ok: true,
        daemon: {
            connection: getMeta('connection') ?? 'unknown',
            meJid: getMeta('me_jid'),
            // El daemon late cada 15s; mas de 60s sin senal es que no esta vivo.
            alive: ageSeconds !== null && ageSeconds < 60,
            heartbeatAgeSeconds: ageSeconds,
            lastReconcileAt: getMeta('last_reconcile_at')
        },
        archive: {
            chats: stats.chats,
            messages: stats.messages,
            oldest: stats.oldestTs ? iso(stats.oldestTs) : null,
            newest: stats.newestTs ? iso(stats.newestTs) : null
        },
        deepgram: { configured: Boolean(config.deepgram.apiKey), model: config.deepgram.model }
    }
})

// --- chats ---------------------------------------------------------------

app.get('/chats', async (request) => {
    const query = request.query as Record<string, string | undefined>
    const rows = listChats({ q: query.q ?? null, limit: intParam(query.limit, 50, 500) })

    return {
        count: rows.length,
        chats: rows.map((row) => ({
            id: row.jid,
            name: row.name,
            kind: row.kind,
            messageCount: row.message_count ?? 0,
            lastMessageAt: row.last_message_ts ? iso(row.last_message_ts) : null
        }))
    }
})

// --- mensajes ------------------------------------------------------------

interface RenderedMessage {
    id: string
    at: string
    fromMe: boolean
    sender: { jid: string | null; name: string | null }
    type: string
    text: string | null
    quotedId: string | null
    media?: Record<string, unknown>
    transcript?: Record<string, unknown>
}

function renderMedia(row: MessageRow, materializedPath: string | null): Record<string, unknown> | undefined {
    if (!row.media_json) return undefined
    const meta = JSON.parse(row.media_json) as Record<string, unknown>
    // MVP: solo imagen y audio se sirven; el resto se archiva con su metadata.
    const servable = row.type === 'image' || row.type === 'audio'

    return {
        ...meta,
        url: servable ? `${baseUrl()}/media/${encodeURIComponent(row.id)}?chatId=${encodeURIComponent(row.chat_jid)}` : null,
        path: materializedPath,
        note: servable ? undefined : `tipo "${row.type}" fuera del MVP: metadata archivada, sin descarga`
    }
}

async function transcriptFor(row: MessageRow): Promise<Record<string, unknown>> {
    const cached = getTranscript(row.id)
    // Un transcript cacheado sin error se reutiliza aunque el texto sea vacio
    // (audio en silencio); los errores si se reintentan.
    if (cached && !cached.error) {
        return { text: cached.text, model: cached.model, language: cached.language, duration: cached.duration, cached: true }
    }

    try {
        const audio = await readMediaBytes(row)
        const result = await transcribe(audio, mimeFor(row))
        saveTranscript({
            msgId: row.id,
            chatJid: row.chat_jid,
            text: result.text,
            model: result.model,
            language: result.language,
            duration: result.duration,
            error: result.error
        })
        return result.error
            ? { text: null, error: result.error }
            : { text: result.text, model: result.model, language: result.language, duration: result.duration, cached: false }
    } catch (error) {
        if (error instanceof DeepgramNotConfigured) {
            return { text: null, error: 'DEEPGRAM_API_KEY no configurada' }
        }
        const detail = error instanceof Error ? error.message : String(error)
        // Un fallo de descarga no se cachea: el CDN puede responder mas tarde.
        return { text: null, error: detail }
    }
}

app.get('/messages', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>
    const chatId = query.chatId ?? query.chat_id
    if (!chatId) {
        return reply.code(400).send({ error: 'bad_request', detail: 'falta el parametro chatId' })
    }

    let fromTs: number | null
    let toTs: number | null
    try {
        fromTs = parseInstant(query.from, 'start')
        toTs = parseInstant(query.to, 'end')
    } catch (error) {
        return reply.code(400).send({ error: 'bad_request', detail: (error as Error).message })
    }

    const limit = intParam(query.limit, 200, 2000)
    const order = query.order === 'desc' ? 'desc' : 'asc'
    const wantTranscripts = boolParam(query.transcribe, true)
    const wantPaths = boolParam(query.materialize, false)

    const rows = listMessages({ chatJid: chatId, fromTs, toTs, limit, order })

    const materialized = new Map<string, string | null>()
    if (wantPaths) {
        const targets = rows.filter((row) => row.type === 'image' || row.type === 'audio')
        await mapPool(targets, 4, async (row) => {
            const path = await materializeMedia(row).catch(() => null)
            materialized.set(row.id, path)
        })
    }

    const transcripts = new Map<string, Record<string, unknown>>()
    if (wantTranscripts) {
        const audios = rows.filter((row) => row.type === 'audio' && row.message_b64)
        await mapPool(audios, 4, async (row) => {
            transcripts.set(row.id, await transcriptFor(row))
        })
    }

    const messages: RenderedMessage[] = rows.map((row) => ({
        id: row.id,
        at: iso(row.ts),
        fromMe: row.from_me === 1,
        sender: { jid: row.sender_jid, name: row.push_name },
        type: row.type,
        text: row.text,
        quotedId: row.quoted_id,
        media: renderMedia(row, materialized.get(row.id) ?? null),
        transcript: transcripts.get(row.id)
    }))

    // Si el rango pedido empieza antes de lo que tenemos, se avisa y se encola un
    // backfill para que el daemon se lo pida al telefono.
    const coverage = chatCoverage(chatId)
    let gap: Record<string, unknown> | undefined
    if (fromTs !== null && (coverage.oldestTs === null || fromTs < coverage.oldestTs)) {
        const anchor = oldestMessage(chatId)
        const queued = enqueueSyncRequest({
            chatJid: chatId,
            oldestMsgId: anchor?.id ?? null,
            oldestFromMe: anchor ? anchor.from_me === 1 : null,
            oldestTs: anchor?.ts ?? null,
            requestedUntil: fromTs
        })
        gap = {
            requestedFrom: iso(fromTs),
            archivedFrom: coverage.oldestTs ? iso(coverage.oldestTs) : null,
            backfillQueued: queued,
            detail: 'El rango pedido es anterior al archivo local. Se pidio historial al telefono; reintenta en unos minutos.'
        }
    }

    const chat = getChat(chatId)

    return {
        chat: { id: chatId, name: chat?.name ?? null, kind: chat?.kind ?? null },
        range: { from: fromTs ? iso(fromTs) : null, to: toTs ? iso(toTs) : null, order, limit },
        coverage: {
            oldest: coverage.oldestTs ? iso(coverage.oldestTs) : null,
            newest: coverage.newestTs ? iso(coverage.newestTs) : null,
            total: coverage.total,
            gap
        },
        count: messages.length,
        messages
    }
})

// --- media ---------------------------------------------------------------

app.get('/media/:msgId', async (request, reply) => {
    const { msgId } = request.params as { msgId: string }
    const query = request.query as Record<string, string | undefined>
    const row = getMessage(msgId, query.chatId ?? null)

    if (!row) {
        return reply.code(404).send({ error: 'not_found', detail: `no hay mensaje ${msgId} en el archivo` })
    }

    try {
        const stream = await openMediaStream(row)
        return reply
            .type(mimeFor(row))
            .header('cache-control', 'private, max-age=86400')
            .send(stream)
    } catch (error) {
        if (error instanceof MediaUnavailable) {
            return reply.code(error.reason === 'expired' ? 410 : 422).send({ error: error.reason, detail: error.message })
        }
        throw error
    }
})

// --- arranque ------------------------------------------------------------

await app.listen({ host: config.host, port: config.port })
console.log(`wa-bridge API escuchando en ${baseUrl()}`)
if (!config.apiKey && config.host !== '127.0.0.1' && config.host !== 'localhost') {
    console.warn('AVISO: la API escucha fuera de loopback y API_KEY esta vacia.')
}
