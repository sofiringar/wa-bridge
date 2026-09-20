import Database from 'better-sqlite3'
import { config, ensureDirs } from './config.js'

export interface ChatRow {
    jid: string
    name: string | null
    kind: string
    last_message_ts: number | null
    message_count?: number
}

export interface MessageRow {
    id: string
    chat_jid: string
    ts: number
    from_me: number
    sender_jid: string | null
    push_name: string | null
    type: string
    text: string | null
    quoted_id: string | null
    media_json: string | null
    message_b64: string | null
    source: string
}

export interface TranscriptRow {
    msg_id: string
    text: string | null
    model: string | null
    language: string | null
    duration: number | null
    error: string | null
}

export interface SyncRequestRow {
    id: number
    chat_jid: string
    oldest_msg_id: string | null
    oldest_from_me: number | null
    oldest_ts: number | null
    requested_until: number | null
}

ensureDirs()

export const db = new Database(config.dbPath)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
db.pragma('busy_timeout = 5000')

db.exec(`
CREATE TABLE IF NOT EXISTS chats (
    jid             TEXT PRIMARY KEY,
    name            TEXT,
    kind            TEXT NOT NULL DEFAULT 'user',
    last_message_ts INTEGER,
    updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id          TEXT NOT NULL,
    chat_jid    TEXT NOT NULL,
    ts          INTEGER NOT NULL,
    from_me     INTEGER NOT NULL DEFAULT 0,
    sender_jid  TEXT,
    push_name   TEXT,
    type        TEXT NOT NULL,
    text        TEXT,
    quoted_id   TEXT,
    media_json  TEXT,
    message_b64    TEXT,
    source      TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (chat_jid, id)
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages (chat_jid, ts);
CREATE INDEX IF NOT EXISTS idx_messages_id ON messages (id);

CREATE TABLE IF NOT EXISTS transcripts (
    msg_id     TEXT PRIMARY KEY,
    chat_jid   TEXT,
    text       TEXT,
    model      TEXT,
    language   TEXT,
    duration   REAL,
    error      TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
    jid        TEXT PRIMARY KEY,
    name       TEXT,
    updated_at INTEGER NOT NULL
);

-- Cola de trabajo entre procesos: la API no tiene sesion conectada, asi que cuando
-- el rango pedido cae antes de lo que tenemos archivado deja aqui la peticion y el
-- daemon la recoge para llamar a client.message.requestHistorySync().
CREATE TABLE IF NOT EXISTS sync_requests (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_jid        TEXT NOT NULL,
    oldest_msg_id   TEXT,
    oldest_from_me  INTEGER,
    oldest_ts       INTEGER,
    requested_until INTEGER,
    status          TEXT NOT NULL DEFAULT 'pending',
    created_at      INTEGER NOT NULL,
    handled_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sync_requests_status ON sync_requests (status, created_at);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);
`)

const now = (): number => Math.floor(Date.now() / 1000)

// --- meta ---------------------------------------------------------------

const stmtSetMeta = db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
)
const stmtGetMeta = db.prepare(`SELECT value FROM meta WHERE key = ?`)

export function setMeta(key: string, value: string): void {
    stmtSetMeta.run(key, value)
}

export function getMeta(key: string): string | null {
    const row = stmtGetMeta.get(key) as { value: string } | undefined
    return row?.value ?? null
}

// --- chats --------------------------------------------------------------

const stmtUpsertChat = db.prepare(
    `INSERT INTO chats (jid, name, kind, last_message_ts, updated_at)
     VALUES (@jid, @name, @kind, @last_message_ts, @updated_at)
     ON CONFLICT(jid) DO UPDATE SET
        name            = COALESCE(excluded.name, chats.name),
        kind            = excluded.kind,
        last_message_ts = MAX(COALESCE(excluded.last_message_ts, 0), COALESCE(chats.last_message_ts, 0)),
        updated_at      = excluded.updated_at`
)

export function upsertChat(input: { jid: string; name?: string | null; kind: string; lastMessageTs?: number | null }): void {
    stmtUpsertChat.run({
        jid: input.jid,
        name: input.name ?? null,
        kind: input.kind,
        last_message_ts: input.lastMessageTs ?? null,
        updated_at: now()
    })
}

export function listChats(options: { q?: string | null; limit: number }): ChatRow[] {
    const like = options.q ? `%${options.q.toLowerCase()}%` : null
    return db
        .prepare(
            `SELECT c.jid, c.name, c.kind, c.last_message_ts,
                    (SELECT COUNT(*) FROM messages m WHERE m.chat_jid = c.jid) AS message_count
             FROM chats c
             WHERE (@like IS NULL OR LOWER(COALESCE(c.name, '')) LIKE @like OR LOWER(c.jid) LIKE @like)
             ORDER BY COALESCE(c.last_message_ts, 0) DESC
             LIMIT @limit`
        )
        .all({ like, limit: options.limit }) as ChatRow[]
}

export function getChat(jid: string): ChatRow | null {
    return (db.prepare(`SELECT jid, name, kind, last_message_ts FROM chats WHERE jid = ?`).get(jid) as ChatRow) ?? null
}

// --- messages -----------------------------------------------------------

const stmtUpsertMessage = db.prepare(
    `INSERT INTO messages (id, chat_jid, ts, from_me, sender_jid, push_name, type, text,
                           quoted_id, media_json, message_b64, source, created_at)
     VALUES (@id, @chat_jid, @ts, @from_me, @sender_jid, @push_name, @type, @text,
             @quoted_id, @media_json, @message_b64, @source, @created_at)
     ON CONFLICT(chat_jid, id) DO UPDATE SET
        ts         = excluded.ts,
        sender_jid = COALESCE(excluded.sender_jid, messages.sender_jid),
        push_name  = COALESCE(excluded.push_name, messages.push_name),
        type       = excluded.type,
        text       = COALESCE(excluded.text, messages.text),
        quoted_id  = COALESCE(excluded.quoted_id, messages.quoted_id),
        media_json = COALESCE(excluded.media_json, messages.media_json),
        message_b64   = COALESCE(excluded.message_b64, messages.message_b64)`
)

export interface MessageInput {
    id: string
    chatJid: string
    ts: number
    fromMe: boolean
    senderJid: string | null
    pushName: string | null
    type: string
    text: string | null
    quotedId: string | null
    mediaJson: string | null
    messageB64: string | null
    source: 'live' | 'history'
}

export function upsertMessage(input: MessageInput): void {
    stmtUpsertMessage.run({
        id: input.id,
        chat_jid: input.chatJid,
        ts: input.ts,
        from_me: input.fromMe ? 1 : 0,
        sender_jid: input.senderJid,
        push_name: input.pushName,
        type: input.type,
        text: input.text,
        quoted_id: input.quotedId,
        media_json: input.mediaJson,
        message_b64: input.messageB64,
        source: input.source,
        created_at: now()
    })
}

export const upsertMessages = db.transaction((rows: MessageInput[]) => {
    for (const row of rows) upsertMessage(row)
})

export function listMessages(options: {
    chatJid: string
    fromTs: number | null
    toTs: number | null
    limit: number
    order: 'asc' | 'desc'
}): MessageRow[] {
    const direction = options.order === 'desc' ? 'DESC' : 'ASC'
    return db
        .prepare(
            `SELECT id, chat_jid, ts, from_me, sender_jid, push_name, type, text,
                    quoted_id, media_json, message_b64, source
             FROM messages
             WHERE chat_jid = @chat_jid
               AND (@from_ts IS NULL OR ts >= @from_ts)
               AND (@to_ts   IS NULL OR ts <= @to_ts)
             ORDER BY ts ${direction}, id ${direction}
             LIMIT @limit`
        )
        .all({
            chat_jid: options.chatJid,
            from_ts: options.fromTs,
            to_ts: options.toTs,
            limit: options.limit
        }) as MessageRow[]
}

export function getMessage(id: string, chatJid?: string | null): MessageRow | null {
    if (chatJid) {
        return (db
            .prepare(
                `SELECT id, chat_jid, ts, from_me, sender_jid, push_name, type, text,
                        quoted_id, media_json, message_b64, source
                 FROM messages WHERE chat_jid = ? AND id = ?`
            )
            .get(chatJid, id) as MessageRow) ?? null
    }
    return (db
        .prepare(
            `SELECT id, chat_jid, ts, from_me, sender_jid, push_name, type, text,
                    quoted_id, media_json, message_b64, source
             FROM messages WHERE id = ? ORDER BY ts DESC LIMIT 1`
        )
        .get(id) as MessageRow) ?? null
}

export interface Coverage {
    oldestTs: number | null
    newestTs: number | null
    total: number
}

export function chatCoverage(chatJid: string): Coverage {
    const row = db
        .prepare(`SELECT MIN(ts) AS oldest, MAX(ts) AS newest, COUNT(*) AS total FROM messages WHERE chat_jid = ?`)
        .get(chatJid) as { oldest: number | null; newest: number | null; total: number }
    return { oldestTs: row.oldest, newestTs: row.newest, total: row.total }
}

/** Mensaje mas antiguo de un chat: el ancla de paginacion que pide requestHistorySync(). */
export function oldestMessage(chatJid: string): MessageRow | null {
    return (db
        .prepare(
            `SELECT id, chat_jid, ts, from_me, sender_jid, push_name, type, text,
                    quoted_id, media_json, message_b64, source
             FROM messages WHERE chat_jid = ? ORDER BY ts ASC LIMIT 1`
        )
        .get(chatJid) as MessageRow) ?? null
}

export function globalStats(): { chats: number; messages: number; oldestTs: number | null; newestTs: number | null } {
    const chats = (db.prepare(`SELECT COUNT(*) AS n FROM chats`).get() as { n: number }).n
    const row = db.prepare(`SELECT COUNT(*) AS n, MIN(ts) AS oldest, MAX(ts) AS newest FROM messages`).get() as {
        n: number
        oldest: number | null
        newest: number | null
    }
    return { chats, messages: row.n, oldestTs: row.oldest, newestTs: row.newest }
}

// --- transcripts --------------------------------------------------------

const stmtGetTranscript = db.prepare(
    `SELECT msg_id, text, model, language, duration, error FROM transcripts WHERE msg_id = ?`
)
const stmtSaveTranscript = db.prepare(
    `INSERT INTO transcripts (msg_id, chat_jid, text, model, language, duration, error, created_at)
     VALUES (@msg_id, @chat_jid, @text, @model, @language, @duration, @error, @created_at)
     ON CONFLICT(msg_id) DO UPDATE SET
        text = excluded.text, model = excluded.model, language = excluded.language,
        duration = excluded.duration, error = excluded.error, created_at = excluded.created_at`
)

export function getTranscript(msgId: string): TranscriptRow | null {
    return (stmtGetTranscript.get(msgId) as TranscriptRow) ?? null
}

export function saveTranscript(input: {
    msgId: string
    chatJid: string
    text: string | null
    model: string | null
    language: string | null
    duration: number | null
    error: string | null
}): void {
    stmtSaveTranscript.run({
        msg_id: input.msgId,
        chat_jid: input.chatJid,
        text: input.text,
        model: input.model,
        language: input.language,
        duration: input.duration,
        error: input.error,
        created_at: now()
    })
}

// --- cola de history sync ----------------------------------------------

export function enqueueSyncRequest(input: {
    chatJid: string
    oldestMsgId: string | null
    oldestFromMe: boolean | null
    oldestTs: number | null
    requestedUntil: number | null
}): boolean {
    // Evita apilar peticiones identicas si la rutina consulta el mismo rango en bucle.
    const pending = db
        .prepare(`SELECT id FROM sync_requests WHERE chat_jid = ? AND status = 'pending' LIMIT 1`)
        .get(input.chatJid)
    if (pending) return false

    db.prepare(
        `INSERT INTO sync_requests (chat_jid, oldest_msg_id, oldest_from_me, oldest_ts, requested_until, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`
    ).run(
        input.chatJid,
        input.oldestMsgId,
        input.oldestFromMe === null ? null : input.oldestFromMe ? 1 : 0,
        input.oldestTs,
        input.requestedUntil,
        now()
    )
    return true
}

export function takePendingSyncRequests(limit = 5): SyncRequestRow[] {
    const rows = db
        .prepare(
            `SELECT id, chat_jid, oldest_msg_id, oldest_from_me, oldest_ts, requested_until
             FROM sync_requests WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`
        )
        .all(limit) as SyncRequestRow[]
    const mark = db.prepare(`UPDATE sync_requests SET status = 'running' WHERE id = ?`)
    for (const row of rows) mark.run(row.id)
    return rows
}

export function finishSyncRequest(id: number, status: 'done' | 'failed'): void {
    db.prepare(`UPDATE sync_requests SET status = ?, handled_at = ? WHERE id = ?`).run(status, now(), id)
}
