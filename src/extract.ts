/**
 * Normalizacion del protobuf de WhatsApp a una fila plana.
 *
 * Tipado laxo a proposito: la union `Proto.IMessage` tiene cientos de variantes y aqui
 * solo nos importan las del MVP (texto, imagen, audio). Las demas se archivan con su
 * etiqueta para no perder el hueco en la conversacion.
 */

type AnyMessage = Record<string, any>

export type MessageType = 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'system' | 'other'

export interface MediaMeta {
    mimetype: string | null
    fileLength: number | null
    /** Solo audio: duracion en segundos. */
    seconds: number | null
    /** Solo audio: true si es nota de voz (push to talk) y no un archivo adjunto. */
    ptt: boolean | null
    fileName: string | null
    width: number | null
    height: number | null
    /** Presencia de estos dos = la media todavia se puede descifrar. */
    hasDirectPath: boolean
    hasMediaKey: boolean
}

export interface Extracted {
    type: MessageType
    text: string | null
    quotedId: string | null
    media: MediaMeta | null
    /** El nodo concreto (imageMessage / audioMessage / ...) ya desenvuelto. */
    mediaNode: AnyMessage | null
}

const WRAPPERS = [
    'ephemeralMessage',
    'viewOnceMessage',
    'viewOnceMessageV2',
    'viewOnceMessageV2Extension',
    'documentWithCaptionMessage',
    'deviceSentMessage',
    'groupMentionedMessage',
    'lottieStickerMessage'
] as const

/** Los mensajes llegan envueltos en capas (efimero, ver-una-vez, enviado-por-otro-dispositivo). */
export function unwrap(message: AnyMessage | null | undefined): AnyMessage | null {
    let current = message ?? null
    for (let depth = 0; current && depth < 8; depth++) {
        const wrapper = WRAPPERS.find((key) => current?.[key]?.message)
        if (!wrapper) break
        current = current[wrapper].message
    }
    return current
}

function num(value: unknown): number | null {
    if (value === null || value === undefined) return null
    const n = typeof value === 'bigint' ? Number(value) : Number(value)
    return Number.isFinite(n) ? n : null
}

function mediaMeta(node: AnyMessage): MediaMeta {
    return {
        mimetype: node.mimetype ?? null,
        fileLength: num(node.fileLength),
        seconds: num(node.seconds),
        ptt: typeof node.ptt === 'boolean' ? node.ptt : null,
        fileName: node.fileName ?? null,
        width: num(node.width),
        height: num(node.height),
        hasDirectPath: Boolean(node.directPath),
        hasMediaKey: Boolean(node.mediaKey)
    }
}

function contextQuotedId(node: AnyMessage | null): string | null {
    return node?.contextInfo?.stanzaId ?? null
}

export function extract(rawMessage: AnyMessage | null | undefined): Extracted {
    const message = unwrap(rawMessage)
    if (!message) {
        return { type: 'other', text: null, quotedId: null, media: null, mediaNode: null }
    }

    if (typeof message.conversation === 'string') {
        return { type: 'text', text: message.conversation, quotedId: null, media: null, mediaNode: null }
    }

    if (message.extendedTextMessage) {
        const node = message.extendedTextMessage
        return {
            type: 'text',
            text: node.text ?? null,
            quotedId: contextQuotedId(node),
            media: null,
            mediaNode: null
        }
    }

    if (message.imageMessage) {
        const node = message.imageMessage
        return {
            type: 'image',
            text: node.caption ?? null,
            quotedId: contextQuotedId(node),
            media: mediaMeta(node),
            mediaNode: node
        }
    }

    if (message.audioMessage) {
        const node = message.audioMessage
        return {
            type: 'audio',
            text: null,
            quotedId: contextQuotedId(node),
            media: mediaMeta(node),
            mediaNode: node
        }
    }

    if (message.videoMessage) {
        const node = message.videoMessage
        return {
            type: 'video',
            text: node.caption ?? null,
            quotedId: contextQuotedId(node),
            media: mediaMeta(node),
            mediaNode: node
        }
    }

    if (message.documentMessage) {
        const node = message.documentMessage
        return {
            type: 'document',
            text: node.caption ?? null,
            quotedId: contextQuotedId(node),
            media: mediaMeta(node),
            mediaNode: node
        }
    }

    if (message.stickerMessage) {
        const node = message.stickerMessage
        return { type: 'sticker', text: null, quotedId: contextQuotedId(node), media: mediaMeta(node), mediaNode: node }
    }

    if (message.protocolMessage || message.senderKeyDistributionMessage || message.messageContextInfo) {
        return { type: 'system', text: null, quotedId: null, media: null, mediaNode: null }
    }

    // Encuestas, ubicaciones, contactos, reacciones, botones... fuera del MVP pero se
    // archivan con su etiqueta para que el hueco sea visible en la conversacion.
    const label = Object.keys(message).find((key) => key.endsWith('Message')) ?? 'unknown'
    return { type: 'other', text: `[${label}]`, quotedId: null, media: null, mediaNode: null }
}

export function chatKind(jid: string): 'user' | 'group' | 'broadcast' | 'newsletter' | 'status' {
    if (jid.endsWith('@g.us')) return 'group'
    if (jid.endsWith('@newsletter')) return 'newsletter'
    if (jid === 'status@broadcast') return 'status'
    if (jid.endsWith('@broadcast')) return 'broadcast'
    return 'user'
}
