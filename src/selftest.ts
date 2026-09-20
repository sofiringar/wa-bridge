/**
 * Verificacion offline del camino de sincronizacion: protobuf de WhatsApp ->
 * fromStoredRecord/fromLiveEvent -> persist -> tablas -> consulta por rango.
 * Es lo mismo que hace reconcileThread(), pero sin socket.
 */
import { proto } from 'zapo-js'
import { fromLiveEvent, fromStoredRecord, persist } from './ingest.js'
import { chatCoverage, listChats, listMessages } from './db.js'

const CHAT = '1203630@g.us'
const ts = (iso: string) => Math.floor(Date.parse(iso) / 1000)

function bytes(message: Record<string, any>): Uint8Array {
    return proto.Message.encode(message as never).finish()
}

// Un registro tal como lo devuelve store.messages.listByThread()
const record = (id: string, iso: string, message: Record<string, any>, participant?: string) => ({
    id,
    threadJid: CHAT,
    timestampMs: ts(iso) * 1000,
    fromMe: false,
    participantJid: participant ?? '5215500001111@s.whatsapp.net',
    messageBytes: bytes(message)
})

const records = [
    record('T1', '2026-09-02T17:21:09Z', { conversation: 'hola, texto simple' }),
    record('T2', '2026-09-03T10:00:00Z', {
        extendedTextMessage: { text: 'respondiendo', contextInfo: { stanzaId: 'T1' } }
    }),
    record('IMG1', '2026-09-04T12:00:00Z', {
        imageMessage: {
            caption: 'asi quedo el stand',
            mimetype: 'image/jpeg',
            fileLength: 184322,
            width: 1280,
            height: 960,
            directPath: '/v/t62.7118-24/abc',
            mediaKey: new Uint8Array(32).fill(7),
            fileEncSha256: new Uint8Array(32).fill(9),
            // Miniatura que el codec debe podar
            jpegThumbnail: new Uint8Array(6000).fill(3)
        }
    }),
    record('AUD1', '2026-09-05T09:30:00Z', {
        audioMessage: {
            mimetype: 'audio/ogg; codecs=opus',
            seconds: 14,
            ptt: true,
            fileLength: 8000,
            directPath: '/v/t62.7117-24/xyz',
            mediaKey: new Uint8Array(32).fill(5)
        }
    }),
    // Envuelto en ephemeral: el unwrap debe atravesarlo
    record('EPH1', '2026-09-06T08:00:00Z', {
        ephemeralMessage: { message: { conversation: 'mensaje efimero' } }
    }),
    // Mensaje de protocolo: NO debe archivarse
    record('SYS1', '2026-09-06T08:05:00Z', { senderKeyDistributionMessage: { groupId: CHAT } }),
    // Fuera del MVP: se archiva con etiqueta
    record('POLL1', '2026-09-07T11:00:00Z', { pollCreationMessage: { name: 'cuando nos vemos?' } }),
    // Fuera del rango que pediremos
    record('OLD1', '2026-08-01T10:00:00Z', { conversation: 'mensaje viejo' })
]

const rows = records.map((r) => fromStoredRecord(r, 'Ana')).filter((r) => r !== null)
console.log(`fromStoredRecord: ${rows.length}/${records.length} filas (SYS1 descartado a proposito)`)

// Evento en vivo, el otro camino de entrada
const live = fromLiveEvent({
    key: { remoteJid: CHAT, id: 'LIVE1', fromMe: false, participant: '5215500002222@s.whatsapp.net' },
    message: { conversation: 'llego en vivo' },
    timestampSeconds: ts('2026-09-08T15:00:00Z'),
    pushName: 'Luis'
})
console.log(`fromLiveEvent: ${live ? 'ok' : 'FALLO'}`)

const total = persist([...rows, live!], new Map([[CHAT, 'Equipo']]))
console.log(`persist: ${total} filas\n`)

// Idempotencia: reprocesar el mismo buzon no debe duplicar
persist([...rows, live!], new Map([[CHAT, 'Equipo']]))
const cov = chatCoverage(CHAT)
console.log(`cobertura tras 2 pasadas: total=${cov.total} (debe ser ${total})`)

console.log('\nchats:', JSON.stringify(listChats({ q: null, limit: 10 })))

console.log('\nrango 2026-09-01 .. 2026-09-30:')
for (const m of listMessages({ chatJid: CHAT, fromTs: ts('2026-09-01T00:00:00Z'), toTs: ts('2026-09-30T23:59:59Z'), limit: 100, order: 'asc' })) {
    const media = m.media_json ? JSON.parse(m.media_json) : null
    const b64 = m.message_b64 ? Buffer.from(m.message_b64, 'base64').length : 0
    console.log(
        `  ${m.id.padEnd(6)} ${new Date(m.ts * 1000).toISOString()} ${m.type.padEnd(8)} quoted=${String(m.quoted_id).padEnd(4)} ` +
            `protobuf=${String(b64).padStart(4)}B ${media ? `media{mime=${media.mimetype} dp=${media.hasDirectPath} mk=${media.hasMediaKey}}` : ''} ${JSON.stringify(m.text)}`
    )
}
