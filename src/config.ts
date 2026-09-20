import 'dotenv/config'
import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function underRoot(value: string): string {
    return isAbsolute(value) ? value : resolve(root, value)
}

const dataDir = underRoot(process.env.DATA_DIR ?? 'data')

export const config = {
    root,
    dataDir,
    /** Nuestra base de datos: mensajes normalizados, chats y transcripciones. */
    dbPath: resolve(dataDir, 'wa-bridge.sqlite'),
    /** Estado de la sesion de zapo (credenciales Noise, sesiones Signal, prekeys). */
    authPath: resolve(dataDir, 'auth.sqlite'),
    /** Donde aterrizan los archivos descifrados cuando se pide ?materialize=true. */
    mediaCacheDir: resolve(dataDir, 'media'),

    host: process.env.HOST ?? '127.0.0.1',
    port: Number(process.env.PORT ?? 8787),
    apiKey: process.env.API_KEY?.trim() || null,

    sessionId: process.env.SESSION_ID ?? 'default',
    requireFullSync: process.env.REQUIRE_FULL_SYNC === 'true',

    deepgram: {
        apiKey: process.env.DEEPGRAM_API_KEY?.trim() || null,
        model: process.env.DEEPGRAM_MODEL ?? 'nova-3',
        language: process.env.DEEPGRAM_LANGUAGE ?? 'multi'
    }
} as const

export function ensureDirs(): void {
    mkdirSync(config.dataDir, { recursive: true })
    mkdirSync(config.mediaCacheDir, { recursive: true })
}

export function baseUrl(): string {
    return `http://${config.host}:${config.port}`
}
