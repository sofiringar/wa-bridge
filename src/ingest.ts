import type { Proto } from 'zapo-js'
import { normalizeMessage } from './codec.js'
import { type MessageInput, upsertChat, upsertMessages } from './db.js'
import { chatKind, extract } from './extract.js'

type AnyRecord = Record<string, any>

function toSeconds(value: unknown): number | null {
    if (value === null || value === undefined) return null
    const n = typeof value === 'bigint' ? Number(value) : Number(value)
    if (!Number.isFinite(n) || n <= 0) return null
    return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n)
}

function build(input: {
    id: string
    chatJid: string
    ts: number
    fromMe: boolean
    senderJid: string | null
    pushName: string | null
    message: Proto.IMessage | Uint8Array
    source: 'live' | 'history'
}): MessageInput | null {
    const { message, base64 } = normalizeMessage(input.message)
    const parsed = extract(message as AnyRecord)
    // Los mensajes de protocolo (claves de grupo, acuses) no son conversacion.
    if (parsed.type === 'system') return null

    return {
        id: input.id,
        chatJid: input.chatJid,
        ts: input.ts,
        fromMe: input.fromMe,
        senderJid: input.senderJid,
        pushName: input.pushName,
        type: parsed.type,
        text: parsed.text,
        quotedId: parsed.quotedId,
        mediaJson: parsed.media ? JSON.stringify(parsed.media) : null,
        messageB64: base64,
        source: input.source
    }
}

/**
 * Evento `message` / `message_send` del stream en vivo.
 *
 * Recibe `unknown` a proposito: los tipos de zapo son interfaces, y TypeScript no les
 * infiere index signature, asi que no encajan en `Record<string, any>` sin un cast.
 */
export function fromLiveEvent(input: unknown): MessageInput | null {
    const event = input as AnyRecord
    const key = event?.key
    if (!key?.remoteJid || !key?.id || !event.message) return null

    const chatJid: string = key.remoteJid
    const fromMe = Boolean(key.fromMe)

    return build({
        id: key.id,
        chatJid,
        ts: toSeconds(event.timestampSeconds) ?? Math.floor(Date.now() / 1000),
        fromMe,
        senderJid: fromMe ? null : key.participant ?? (chatJid.endsWith('@g.us') ? null : chatJid),
        pushName: event.pushName ?? null,
        message: event.message,
        source: 'live'
    })
}

/**
 * Registro del store de zapo (`WaStoredMessageRecord`). Es la unica via para el
 * historial: el evento `history_sync_chunk` solo entrega contadores, los mensajes
 * los escribe la libreria directamente en su store.
 */
export function fromStoredRecord(input: unknown, pushName: string | null): MessageInput | null {
    const record = input as AnyRecord
    if (!record?.id || !record?.threadJid || !record?.messageBytes) return null

    const ts = toSeconds(record.timestampMs)
    if (ts === null) return null

    return build({
        id: record.id,
        chatJid: record.threadJid,
        ts,
        fromMe: Boolean(record.fromMe),
        senderJid: record.participantJid ?? record.senderJid ?? null,
        pushName,
        message: record.messageBytes as Uint8Array,
        source: 'history'
    })
}

/** Persiste un lote y mantiene la tabla de chats al dia en la misma pasada. */
export function persist(rows: MessageInput[], chatNames?: Map<string, string | null>): number {
    if (rows.length === 0) return 0

    upsertMessages(rows)

    const latest = new Map<string, { ts: number; name: string | null }>()
    for (const row of rows) {
        const previous = latest.get(row.chatJid)
        // En 1:1 el pushName del interlocutor es el mejor nombre disponible.
        const candidate = !row.fromMe && !row.chatJid.endsWith('@g.us') ? row.pushName : null
        if (!previous || row.ts > previous.ts) {
            latest.set(row.chatJid, { ts: row.ts, name: candidate ?? previous?.name ?? null })
        } else if (candidate && !previous.name) {
            previous.name = candidate
        }
    }

    for (const [jid, info] of latest) {
        upsertChat({
            jid,
            name: chatNames?.get(jid) ?? info.name,
            kind: chatKind(jid),
            lastMessageTs: info.ts
        })
    }

    return rows.length
}
