import { proto, type Proto } from 'zapo-js'

/**
 * Archivamos el mensaje como el propio zapo lo guarda: `proto.Message` codificado.
 * Es compacto, no pierde los campos binarios (mediaKey, fileEncSha256) y se vuelve a
 * decodificar sin ambiguedad, a diferencia de un JSON.stringify sobre Uint8Array.
 */

const MEDIA_NODES = [
    'imageMessage',
    'videoMessage',
    'audioMessage',
    'documentMessage',
    'stickerMessage',
    'ptvMessage'
] as const

const WRAPPERS = [
    'ephemeralMessage',
    'viewOnceMessage',
    'viewOnceMessageV2',
    'viewOnceMessageV2Extension',
    'documentWithCaptionMessage',
    'deviceSentMessage'
] as const

/**
 * Las miniaturas embebidas pesan varios KB por mensaje y no aportan nada: la imagen
 * completa se descarga bajo demanda. Se podan antes de archivar.
 */
function pruneThumbnails(message: Record<string, any> | null | undefined): void {
    let current = message
    for (let depth = 0; current && depth < 8; depth++) {
        for (const key of MEDIA_NODES) {
            const node = current[key]
            if (node) {
                node.jpegThumbnail = null
                node.thumbnailDirectPath = null
                node.thumbnailSha256 = null
                node.thumbnailEncSha256 = null
                node.streamingSidecar = null
                node.firstFrameSidecar = null
            }
        }
        const wrapper = WRAPPERS.find((key) => current?.[key]?.message)
        if (!wrapper) return
        current = current[wrapper].message
    }
}

/**
 * Normaliza a un par (objeto decodificado, base64 listo para archivar). Acepta tanto
 * el `Proto.IMessage` del evento en vivo como los `messageBytes` del store de zapo.
 */
export function normalizeMessage(input: Proto.IMessage | Uint8Array): { message: Proto.IMessage; base64: string } {
    const bytes = input instanceof Uint8Array ? input : proto.Message.encode(input).finish()
    const message = proto.Message.decode(bytes) as unknown as Record<string, any>
    pruneThumbnails(message)
    const pruned = proto.Message.encode(message as never).finish()
    return { message: message as Proto.IMessage, base64: Buffer.from(pruned).toString('base64') }
}

export function decodeMessage(base64: string): Proto.IMessage {
    return proto.Message.decode(Buffer.from(base64, 'base64')) as unknown as Proto.IMessage
}
