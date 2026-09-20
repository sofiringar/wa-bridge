import { createWriteStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { downloadMediaMessage } from 'zapo-js'
import { decodeMessage } from './codec.js'
import { config } from './config.js'
import type { MessageRow } from './db.js'
import { extract } from './extract.js'

export class MediaUnavailable extends Error {
    constructor(
        message: string,
        readonly reason: 'no-metadata' | 'expired' | 'failed'
    ) {
        super(message)
    }
}

const EXTENSIONS: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/amr': 'amr',
    'audio/wav': 'wav',
    'video/mp4': 'mp4'
}

function mediaNodeOf(row: MessageRow): Record<string, any> | null {
    if (!row.message_b64) return null
    return extract(decodeMessage(row.message_b64) as Record<string, any>).mediaNode
}

export function mimeFor(row: MessageRow): string {
    const raw = mediaNodeOf(row)?.mimetype as string | undefined
    return raw?.split(';')[0]?.trim() || 'application/octet-stream'
}

export function extensionFor(mimetype: string | null): string {
    const base = mimetype?.split(';')[0]?.trim().toLowerCase() ?? ''
    return EXTENSIONS[base] ?? 'bin'
}

/**
 * El protobuf archivado conserva directPath, mediaKey y fileEncSha256, que es todo lo
 * que hace falta: `downloadMediaMessage` es standalone, no necesita sesion conectada.
 */
function sourceOf(row: MessageRow): Record<string, any> {
    if (!row.message_b64) {
        throw new MediaUnavailable(`El mensaje ${row.id} no tiene protobuf archivado`, 'no-metadata')
    }
    const message = decodeMessage(row.message_b64) as unknown as Record<string, any>
    const node = extract(message).mediaNode
    if (!node) {
        throw new MediaUnavailable(`El mensaje ${row.id} no contiene media`, 'no-metadata')
    }
    if (!node.directPath || !node.mediaKey) {
        throw new MediaUnavailable(
            `El mensaje ${row.id} no conserva directPath/mediaKey; no se puede descifrar`,
            'no-metadata'
        )
    }
    return message
}

function wrapDownloadError(row: MessageRow, error: unknown): MediaUnavailable {
    const detail = error instanceof Error ? error.message : String(error)
    // El CDN purga los blobs a las pocas semanas; despues ya no hay nada que descifrar.
    if (/\b(404|410)\b|not found|gone/i.test(detail)) {
        return new MediaUnavailable(
            `El archivo del mensaje ${row.id} ya no esta en el CDN de WhatsApp (purgado por antiguedad)`,
            'expired'
        )
    }
    return new MediaUnavailable(`No se pudo descargar la media de ${row.id}: ${detail}`, 'failed')
}

/**
 * Descarga desde el CDN de Meta y descifra al vuelo (AES-256-CBC con clave derivada por
 * HKDF de la mediaKey). Meta solo almacena el cifrado; el plaintext nunca sale de aqui.
 */
export async function openMediaStream(row: MessageRow, timeoutMs = 60_000): Promise<Readable> {
    const source = sourceOf(row)
    try {
        return await downloadMediaMessage(source as never, { timeoutMs })
    } catch (error) {
        throw wrapDownloadError(row, error)
    }
}

export async function readMediaBytes(row: MessageRow, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
    const stream = await openMediaStream(row)
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
        total += buffer.length
        if (total > maxBytes) {
            stream.destroy()
            throw new MediaUnavailable(`La media de ${row.id} excede ${maxBytes} bytes`, 'failed')
        }
        chunks.push(buffer)
    }
    return Buffer.concat(chunks)
}

function cachePathFor(row: MessageRow): string {
    const safeChat = row.chat_jid.replace(/[^a-zA-Z0-9._-]/g, '_')
    const safeId = row.id.replace(/[^a-zA-Z0-9._-]/g, '_')
    return resolve(config.mediaCacheDir, safeChat, `${safeId}.${extensionFor(mimeFor(row))}`)
}

/**
 * Escribe el archivo descifrado en la cache y devuelve su ruta absoluta, para que la
 * herramienta Read de Claude Code pueda abrirlo: una URL de localhost no le sirve,
 * WebFetch rechaza hosts sin punto.
 */
export async function materializeMedia(row: MessageRow): Promise<string> {
    const target = cachePathFor(row)

    const existing = await stat(target).catch(() => null)
    if (existing?.isFile() && existing.size > 0) return target

    await mkdir(dirname(target), { recursive: true })
    const stream = await openMediaStream(row)
    await pipeline(stream, createWriteStream(target))
    return target
}
