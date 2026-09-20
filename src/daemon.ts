import { createSqliteStore } from '@zapo-js/store-sqlite'
import qrcode from 'qrcode-terminal'
import { ConsoleLogger, createStore, WaClient, type WaStoreSession } from 'zapo-js'
import { config, ensureDirs } from './config.js'
import { CredsError, restoreFromEnvIfNeeded } from './creds.js'
import { finishSyncRequest, type MessageInput, setMeta, takePendingSyncRequests } from './db.js'
import { fromLiveEvent, fromStoredRecord, persist } from './ingest.js'

ensureDirs()

const log = (...args: unknown[]): void => console.log(new Date().toISOString(), ...args)

// Ambiente nuevo sin store local pero con credenciales en el entorno (WA_CREDS o
// WA_CREDS_FILE): se rehidrata data/auth.sqlite antes de abrir el store, y asi se
// reanuda la sesion ya emparejada sin volver a escanear el QR.
try {
    restoreFromEnvIfNeeded(log)
} catch (error) {
    if (error instanceof CredsError) {
        log('no se pudieron restaurar las credenciales del entorno:', error.message)
        process.exit(1)
    }
    throw error
}

const store = createStore({
    backends: { sqlite: createSqliteStore({ path: config.authPath }) },
    providers: {
        auth: 'sqlite',
        signal: 'sqlite',
        preKey: 'sqlite',
        session: 'sqlite',
        identity: 'sqlite',
        senderKey: 'sqlite',
        appState: 'sqlite',
        privacyToken: 'sqlite',
        // Los tres dominios de buzon son obligatorios aqui: el historial de
        // WhatsApp aterriza en ellos, no en el evento history_sync_chunk.
        messages: 'sqlite',
        threads: 'sqlite',
        contacts: 'sqlite'
    }
})

const client = new WaClient(
    {
        store,
        sessionId: config.sessionId,
        history: { enabled: true, requireFullSync: config.requireFullSync },
        markOnlineOnConnect: false,
        recoverFromClientTooOld: true
    },
    new ConsoleLogger('info')
)

// --- espejo del historial ------------------------------------------------

const PAGE_SIZE = 200
const MAX_PAGES_PER_THREAD = 2000

/**
 * zapo persiste el historial en su propio store y solo emite contadores en
 * `history_sync_chunk`. Esta pasada copia ese buzon a nuestra tabla normalizada,
 * que es la que la API consulta por rango de fechas.
 */
async function reconcileThread(
    session: WaStoreSession,
    thread: { jid: string; name?: string },
    names: Map<string, string | null>
): Promise<number> {
    const threadJid = thread.jid
    const chatNames = new Map<string, string | null>([[threadJid, thread.name ?? null]])
    let before: number | undefined
    let imported = 0

    for (let page = 0; page < MAX_PAGES_PER_THREAD; page++) {
        const records = await session.messages.listByThread(threadJid, PAGE_SIZE, before)
        if (records.length === 0) break

        const rows: MessageInput[] = []
        for (const record of records) {
            const senderJid = record.participantJid ?? record.senderJid ?? null
            if (senderJid && !names.has(senderJid)) {
                const contact = await session.contacts.getByJid(senderJid).catch(() => null)
                names.set(senderJid, contact?.displayName ?? contact?.pushName ?? null)
            }
            const row = fromStoredRecord(record, senderJid ? (names.get(senderJid) ?? null) : null)
            if (row) rows.push(row)
        }

        imported += persist(rows, chatNames)

        // listByThread ordena timestamp_ms DESC, asi que el ultimo registro es el
        // mas antiguo de la pagina y sirve de cursor hacia atras.
        const oldest = records[records.length - 1]?.timestampMs
        if (records.length < PAGE_SIZE || oldest === undefined) break
        if (before !== undefined && oldest >= before) break
        before = oldest
    }

    return imported
}

let reconciling = false
let reconcileQueued = false

async function reconcile(): Promise<void> {
    if (reconciling) {
        reconcileQueued = true
        return
    }
    reconciling = true
    try {
        const session = store.session(config.sessionId)
        const threads = await session.threads.list(5000)
        const names = new Map<string, string | null>()
        let total = 0

        for (const thread of threads) {
            const imported = await reconcileThread(session, thread, names).catch((error) => {
                log(`reconcile ${thread.jid} fallo:`, error)
                return 0
            })
            total += imported
        }

        setMeta('last_reconcile_at', String(Math.floor(Date.now() / 1000)))
        if (total > 0) log(`reconcile: ${total} mensajes archivados de ${threads.length} chats`)
    } finally {
        reconciling = false
        if (reconcileQueued) {
            reconcileQueued = false
            void reconcile()
        }
    }
}

let reconcileTimer: NodeJS.Timeout | null = null

/** Los chunks llegan en rafaga; se espera a que amaine antes de copiar el buzon. */
function scheduleReconcile(delayMs = 5_000): void {
    if (reconcileTimer) clearTimeout(reconcileTimer)
    reconcileTimer = setTimeout(() => {
        reconcileTimer = null
        void reconcile()
    }, delayMs)
}

// --- eventos -------------------------------------------------------------

client.on('auth_qr', ({ qr }) => {
    log('Escanea este QR desde WhatsApp > Dispositivos vinculados:')
    qrcode.generate(qr, { small: true })
})

client.on('auth_paired', ({ credentials }) => {
    log('emparejado como', credentials.meJid)
    setMeta('me_jid', String(credentials.meJid ?? ''))
})

client.on('message', (event) => {
    const row = fromLiveEvent(event)
    if (row) persist([row])
})

client.on('message_send', (event) => {
    const row = fromLiveEvent(event)
    if (row) persist([row])
})

client.on('history_sync_chunk', (event) => {
    log(`history chunk: ${event.messagesCount} mensajes, ${event.conversationsCount} chats, progreso ${event.progress ?? '?'}%`)
    scheduleReconcile()
})

// --- reconexion ----------------------------------------------------------

const MAX_ATTEMPTS = 12
let attempt = 0
let stopping = false

client.on('connection', (event) => {
    if (event.status === 'open') {
        attempt = 0
        setMeta('connection', 'open')
        log('conectado')
        // Al abrir, el buzon puede traer lo que llego mientras estabamos fuera.
        scheduleReconcile(10_000)
        return
    }

    setMeta('connection', 'closed')
    if (stopping) return

    if (event.isLogout) {
        setMeta('connection', 'logged_out')
        log('sesion cerrada desde el telefono: hay que volver a emparejar. Borra data/auth.sqlite y reinicia.')
        return
    }

    log('desconectado:', event.reason, '- reintentando')
    void reconnect()
})

async function reconnect(): Promise<void> {
    if (stopping) return
    if (attempt >= MAX_ATTEMPTS) {
        log(`sin reintentos tras ${attempt} intentos; saliendo`)
        process.exitCode = 1
        return
    }
    const delayMs = Math.min(30_000, 1_000 * 2 ** attempt)
    attempt += 1
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    try {
        await client.connect()
    } catch (error) {
        log('fallo la reconexion:', error)
        void reconnect()
    }
}

// --- cola de backfill que deja la API -----------------------------------

async function drainSyncRequests(): Promise<void> {
    const pending = takePendingSyncRequests(3)
    for (const request of pending) {
        try {
            await client.message.requestHistorySync({
                chatJid: request.chat_jid,
                oldestMsgId: request.oldest_msg_id ?? undefined,
                oldestMsgFromMe: request.oldest_from_me === null ? undefined : request.oldest_from_me === 1,
                oldestMsgTimestampMs: request.oldest_ts === null ? undefined : request.oldest_ts * 1000,
                count: 200
            })
            finishSyncRequest(request.id, 'done')
            log(`backfill solicitado para ${request.chat_jid}`)
        } catch (error) {
            finishSyncRequest(request.id, 'failed')
            log(`backfill fallo para ${request.chat_jid}:`, error)
        }
    }
}

const syncTimer = setInterval(() => void drainSyncRequests(), 5_000)
const heartbeatTimer = setInterval(() => setMeta('daemon_heartbeat', String(Math.floor(Date.now() / 1000))), 15_000)
// Red de seguridad por si algun chunk no dispara el debounce.
const periodicTimer = setInterval(() => scheduleReconcile(0), 15 * 60 * 1000)

// --- ciclo de vida -------------------------------------------------------

async function shutdown(signal: string): Promise<void> {
    if (stopping) return
    stopping = true
    log(`${signal}: cerrando`)
    clearInterval(syncTimer)
    clearInterval(heartbeatTimer)
    clearInterval(periodicTimer)
    if (reconcileTimer) clearTimeout(reconcileTimer)
    setMeta('connection', 'stopped')
    await client.disconnect().catch(() => {})
    await store.destroy().catch(() => {})
    process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

setMeta('daemon_started_at', String(Math.floor(Date.now() / 1000)))
log('conectando...')
// Un fallo en el primer connect() entra en la misma escalera de reintentos que una
// caida posterior; dejarlo escapar aqui tumbaba el proceso sin reintentar ni una vez.
try {
    await client.connect()
} catch (error) {
    log('fallo la conexion inicial:', error)
    void reconnect()
}
