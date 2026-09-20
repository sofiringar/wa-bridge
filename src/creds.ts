/**
 * Exportacion / importacion portable de las credenciales de sesion de zapo.
 *
 * El objetivo: emparejar el telefono UNA vez, llevarse el resultado como una sola
 * cadena base64 y rehidratarlo en otro ambiente (CI, contenedor, otra maquina) via
 * variable de entorno, sin volver a escanear el QR.
 *
 * Que se lleva: `data/auth.sqlite` completo salvo las tablas volatiles. Se copia con
 * `VACUUM INTO`, que toma una instantanea consistente incluso con el daemon corriendo
 * y con el WAL sin checkpoint — copiar el archivo a pelo se dejaria cambios en el
 * `-wal` y produciria un store corrupto o vacio.
 *
 * Por que el archivo entero y no un JSON de filas: preserva el esquema y la tabla
 * `wa_migrations`, asi que la version de @zapo-js/store-sqlite que lo importe no
 * intenta re-aplicar migraciones sobre datos que ya las tienen.
 */

import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { config } from './config.js'

/**
 * Tablas que NO viajan: buzon de historial (puede pesar cientos de MB), caches
 * reconstruibles y colas de reintento. Nada de esto hace falta para reanudar la sesion.
 */
const VOLATILE_TABLES = [
    'mailbox_messages',
    'mailbox_threads',
    'mailbox_contacts',
    'chat_metadata_cache',
    'device_list_cache',
    'group_participants_cache',
    'message_secrets_cache',
    'retry_inbound_counters',
    'retry_outbound_messages',
    'appstate_collection_index_values'
] as const

/** Los 16 bytes de cabecera de todo archivo SQLite: "SQLite format 3\0". */
const SQLITE_MAGIC = Buffer.from('53514c69746520666f726d6174203300', 'hex')

export interface CredsPayload {
    /** La cadena que se guarda en la variable de entorno. */
    base64: string
    /** Bytes del sqlite podado, antes de comprimir. */
    rawBytes: number
    gzipBytes: number
    base64Chars: number
    meJid: string | null
    pushName: string | null
    sessionIds: string[]
    /** Filas por tabla que viajan, para poder auditar el contenido de un vistazo. */
    tables: Record<string, number>
}

export class CredsError extends Error {}

function tableNames(db: Database.Database): string[] {
    return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map(
        (row) => row.name
    )
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
    const columns = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{ name: string }>
    return columns.some((row) => row.name === column)
}

/**
 * Empaqueta el store de autenticacion en una cadena base64.
 *
 * @param sessionId Si se indica, solo viajan las filas de esa sesion. Por defecto, la
 *                  del `.env` (`SESSION_ID`).
 */
export function exportCredentials(options: { sessionId?: string | null } = {}): CredsPayload {
    if (!existsSync(config.authPath)) {
        throw new CredsError(
            `No existe ${config.authPath}. Empareja primero el telefono con "npm run daemon" y vuelve a intentarlo.`
        )
    }

    const sessionId = options.sessionId === undefined ? config.sessionId : options.sessionId
    const snapshot = resolve(config.dataDir, `creds-snapshot-${process.pid}.sqlite`)
    rmSync(snapshot, { force: true })

    // Solo lectura: el daemon puede estar corriendo y el store de zapo es de un unico
    // escritor. VACUUM INTO escribe en el destino, no en el origen.
    const source = new Database(config.authPath, { readonly: true })
    try {
        source.prepare(`VACUUM INTO ?`).run(snapshot)
    } finally {
        source.close()
    }

    const pruned = new Database(snapshot)
    let payload: CredsPayload
    try {
        const present = new Set(tableNames(pruned))

        for (const table of VOLATILE_TABLES) {
            if (present.has(table)) pruned.exec(`DROP TABLE "${table}"`)
        }

        // Un mismo store puede alojar varias sesiones; no arrastres las ajenas.
        if (sessionId) {
            for (const table of tableNames(pruned)) {
                if (hasColumn(pruned, table, 'session_id')) {
                    pruned.prepare(`DELETE FROM "${table}" WHERE session_id <> ?`).run(sessionId)
                }
            }
        }

        const credentials = pruned
            .prepare(`SELECT session_id, me_jid, push_name FROM auth_credentials ORDER BY session_id`)
            .all() as Array<{ session_id: string; me_jid: string | null; push_name: string | null }>

        if (credentials.length === 0) {
            throw new CredsError(
                sessionId
                    ? `El store no tiene credenciales para la sesion "${sessionId}". Empareja el telefono antes de exportar.`
                    : 'El store no tiene ninguna credencial. Empareja el telefono antes de exportar.'
            )
        }
        if (!credentials.some((row) => row.me_jid)) {
            throw new CredsError(
                'Hay credenciales pero sin me_jid: el emparejamiento no se completo. Escanea el QR y espera a que el daemon diga "conectado".'
            )
        }

        const tables: Record<string, number> = {}
        for (const table of tableNames(pruned).sort()) {
            tables[table] = (pruned.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n
        }

        // Recupera el espacio de lo borrado: sin esto el base64 carga paginas muertas.
        pruned.exec('VACUUM')
        pruned.close()

        const raw = readFileSync(snapshot)
        const gzip = gzipSync(raw, { level: 9 })
        const base64 = gzip.toString('base64')

        payload = {
            base64,
            rawBytes: raw.length,
            gzipBytes: gzip.length,
            base64Chars: base64.length,
            meJid: credentials.find((row) => row.me_jid)?.me_jid ?? null,
            pushName: credentials.find((row) => row.push_name)?.push_name ?? null,
            sessionIds: credentials.map((row) => row.session_id),
            tables
        }
    } finally {
        if (pruned.open) pruned.close()
        rmSync(snapshot, { force: true })
    }

    return payload
}

export interface ImportSummary {
    authPath: string
    bytes: number
    meJid: string | null
    pushName: string | null
    sessionIds: string[]
}

/** Decodifica y valida el blob sin tocar el disco de destino. */
function decode(blob: string): Buffer {
    const cleaned = blob.trim().replace(/\s+/g, '')
    if (cleaned.length === 0) throw new CredsError('El blob de credenciales esta vacio.')

    let gzip: Buffer
    try {
        gzip = Buffer.from(cleaned, 'base64')
    } catch {
        throw new CredsError('El blob no es base64 valido.')
    }

    let raw: Buffer
    try {
        raw = gunzipSync(gzip)
    } catch {
        throw new CredsError('El blob no descomprime: base64 truncado o no generado por "npm run creds:export".')
    }

    if (!raw.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) {
        throw new CredsError('El contenido descomprimido no es una base SQLite.')
    }
    return raw
}

/**
 * Rehidrata `data/auth.sqlite` desde el blob.
 *
 * Se escribe primero a un temporal y se valida ahi: un blob corrupto no debe dejar el
 * store a medias. Los `-wal` / `-shm` viejos se borran, porque pertenecen al archivo
 * anterior y SQLite los daria por buenos.
 */
export function importCredentials(blob: string, options: { force?: boolean } = {}): ImportSummary {
    const raw = decode(blob)

    if (existsSync(config.authPath) && !options.force) {
        throw new CredsError(
            `Ya existe ${config.authPath}. Usa --force para sobrescribirlo (perderas la sesion emparejada ahi).`
        )
    }

    mkdirSync(dirname(config.authPath), { recursive: true })
    const staging = `${config.authPath}.incoming-${process.pid}`
    rmSync(staging, { force: true })
    writeFileSync(staging, raw)

    let summary: ImportSummary
    try {
        const db = new Database(staging, { readonly: true })
        try {
            const credentials = db
                .prepare(`SELECT session_id, me_jid, push_name FROM auth_credentials ORDER BY session_id`)
                .all() as Array<{ session_id: string; me_jid: string | null; push_name: string | null }>
            if (credentials.length === 0) throw new CredsError('El blob no contiene credenciales.')

            summary = {
                authPath: config.authPath,
                bytes: raw.length,
                meJid: credentials.find((row) => row.me_jid)?.me_jid ?? null,
                pushName: credentials.find((row) => row.push_name)?.push_name ?? null,
                sessionIds: credentials.map((row) => row.session_id)
            }
        } finally {
            db.close()
        }
    } catch (error) {
        rmSync(staging, { force: true })
        if (error instanceof CredsError) throw error
        throw new CredsError(`El blob no es un store de zapo valido: ${(error as Error).message}`)
    }

    rmSync(`${config.authPath}-wal`, { force: true })
    rmSync(`${config.authPath}-shm`, { force: true })
    rmSync(config.authPath, { force: true })
    // renameSync via writeFile+rm ya hecho: movemos el staging validado a su sitio.
    writeFileSync(config.authPath, readFileSync(staging))
    rmSync(staging, { force: true })

    return summary
}

/** El blob tal como lo ve el proceso: variable de entorno directa o a traves de un archivo. */
export function credsFromEnv(): { blob: string; origin: string } | null {
    const inline = process.env.WA_CREDS?.trim()
    if (inline) return { blob: inline, origin: 'WA_CREDS' }

    const path = process.env.WA_CREDS_FILE?.trim()
    if (path) {
        const resolved = resolve(config.root, path)
        if (!existsSync(resolved)) {
            throw new CredsError(`WA_CREDS_FILE apunta a ${resolved}, que no existe.`)
        }
        return { blob: readFileSync(resolved, 'utf8'), origin: `WA_CREDS_FILE (${resolved})` }
    }
    return null
}

/**
 * Arranque en un ambiente nuevo: si no hay store local pero si credenciales en el
 * entorno, se rehidratan. Si ya hay store local, manda el local — reimportar por
 * encima de una sesion viva la rompe.
 */
export function restoreFromEnvIfNeeded(log: (...args: unknown[]) => void = console.log): boolean {
    const hasLocal = existsSync(config.authPath) && statSync(config.authPath).size > 0
    const fromEnv = credsFromEnv()

    if (!fromEnv) return false
    if (hasLocal) {
        log(`credenciales en el entorno ignoradas: ya existe ${config.authPath}`)
        return false
    }

    const summary = importCredentials(fromEnv.blob)
    log(`credenciales restauradas desde ${fromEnv.origin}: ${summary.meJid ?? 'sin me_jid'} (${summary.bytes} bytes)`)
    return true
}
