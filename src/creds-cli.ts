/**
 * CLI de credenciales.
 *
 *   npm run creds:export              -> escribe data/wa-creds.b64 y resume el contenido
 *   npm run creds:export -- --stdout  -> solo el blob por stdout (para pipes)
 *   npm run creds:import -- --force   -> rehidrata data/auth.sqlite desde WA_CREDS
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { config, ensureDirs } from './config.js'
import { credsFromEnv, CredsError, exportCredentials, importCredentials } from './creds.js'

const argv = process.argv.slice(2)
const command = argv[0]
const has = (flag: string): boolean => argv.includes(flag)

function valueOf(flag: string): string | null {
    const index = argv.indexOf(flag)
    if (index === -1) return null
    return argv[index + 1] ?? null
}

/**
 * Solo se invoca con --stdin explicito: leer la entrada estandar "por si acaso" cuelga
 * el proceso indefinidamente cuando nadie va a escribir en ella (terminal interactiva,
 * runner de CI con stdin heredado y abierto).
 */
function readStdin(): string {
    try {
        return readFileSync(0, 'utf8')
    } catch {
        return ''
    }
}

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`

function runExport(): void {
    ensureDirs()
    const sessionId = valueOf('--session') ?? undefined
    const payload = exportCredentials(sessionId === undefined ? {} : { sessionId })

    if (has('--stdout')) {
        process.stdout.write(payload.base64)
        return
    }

    const target = resolve(valueOf('--out') ?? resolve(config.dataDir, 'wa-creds.b64'))
    writeFileSync(target, payload.base64, { mode: 0o600 })

    console.log(`credenciales exportadas -> ${target}`)
    console.log(`  cuenta        ${payload.meJid ?? '(sin me_jid)'}${payload.pushName ? ` — ${payload.pushName}` : ''}`)
    console.log(`  sesiones      ${payload.sessionIds.join(', ')}`)
    console.log(`  sqlite podado ${kb(payload.rawBytes)} -> gzip ${kb(payload.gzipBytes)} -> base64 ${payload.base64Chars} chars`)
    console.log('  tablas        ' + Object.entries(payload.tables).map(([t, n]) => `${t}=${n}`).join(' '))
    console.log('')

    // 128 KB es el tope habitual de una sola variable de entorno en Linux (MAX_ARG_STRLEN).
    if (payload.base64Chars > 120_000) {
        console.warn(
            `AVISO: ${payload.base64Chars} caracteres se acercan al limite de una variable de entorno (~128 KB).\n` +
                '       Usa WA_CREDS_FILE en lugar de WA_CREDS en ese ambiente.'
        )
        console.log('')
    }

    console.log('Para cargarlo en otro ambiente, cualquiera de las dos:')
    console.log(`  export WA_CREDS="$(cat ${target})"      # el blob en la variable`)
    console.log(`  export WA_CREDS_FILE=${target}          # la ruta al blob`)
    console.log('')
    console.log('El daemon las rehidrata solo si no hay data/auth.sqlite local.')
    console.log('Trata este archivo como una contraseña: da acceso completo a la cuenta de WhatsApp.')
}

async function runImport(): Promise<void> {
    ensureDirs()
    const fromEnv = credsFromEnv()
    const fromFile = valueOf('--in')

    let blob: string
    let origin: string
    if (fromFile) {
        blob = readFileSync(resolve(fromFile), 'utf8')
        origin = `--in ${fromFile}`
    } else if (fromEnv) {
        blob = fromEnv.blob
        origin = fromEnv.origin
    } else if (has('--stdin')) {
        blob = readStdin()
        origin = 'stdin'
    } else {
        throw new CredsError(
            'No hay credenciales que importar. Define WA_CREDS o WA_CREDS_FILE, pasa --in <archivo>, o --stdin para leerlas de la entrada estandar.'
        )
    }

    if (!blob.trim()) {
        throw new CredsError(`No llego ningun contenido desde ${origin}.`)
    }
    const summary = await importCredentials(blob, { force: has('--force') })

    console.log(`credenciales importadas desde ${origin} -> ${summary.authPath}`)
    console.log(`  cuenta   ${summary.meJid ?? '(sin me_jid)'}${summary.pushName ? ` — ${summary.pushName}` : ''}`)
    console.log(`  sesiones ${summary.sessionIds.join(', ')}`)
    console.log(`  tamaño   ${kb(summary.bytes)}`)
    console.log('')
    console.log('Arranca el daemon: deberia conectar sin pedir QR.')
}

try {
    if (command === 'export') runExport()
    else if (command === 'import') await runImport()
    else {
        console.error('uso: creds-cli <export|import> [opciones]')
        console.error('')
        console.error('  export [--out <archivo>] [--stdout] [--session <id>]')
        console.error('  import [--in <archivo>] [--stdin] [--force]')
        process.exitCode = 2
    }
} catch (error) {
    if (error instanceof CredsError) {
        console.error(`error: ${error.message}`)
        process.exitCode = 1
    } else {
        throw error
    }
}
