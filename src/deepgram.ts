import { config } from './config.js'

export interface TranscriptionResult {
    text: string | null
    model: string
    language: string | null
    duration: number | null
    error: string | null
}

export class DeepgramNotConfigured extends Error {
    constructor() {
        super('DEEPGRAM_API_KEY no esta configurada')
    }
}

/**
 * Transcribe un audio ya descifrado. Deepgram acepta el opus/ogg de las notas de voz
 * de WhatsApp tal cual, sin transcodificar, siempre que el Content-Type sea correcto.
 */
export async function transcribe(audio: Buffer, mimetype: string | null): Promise<TranscriptionResult> {
    if (!config.deepgram.apiKey) throw new DeepgramNotConfigured()

    const params = new URLSearchParams({
        model: config.deepgram.model,
        language: config.deepgram.language,
        smart_format: 'true',
        punctuate: 'true'
    })

    // El mimetype de WhatsApp suele venir como "audio/ogg; codecs=opus".
    const contentType = mimetype?.split(';')[0]?.trim() || 'audio/ogg'

    const response = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
        method: 'POST',
        headers: {
            Authorization: `Token ${config.deepgram.apiKey}`,
            'Content-Type': contentType
        },
        body: new Uint8Array(audio)
    })

    if (!response.ok) {
        const detail = await response.text().catch(() => '')
        return {
            text: null,
            model: config.deepgram.model,
            language: null,
            duration: null,
            error: `deepgram ${response.status}: ${detail.slice(0, 300)}`
        }
    }

    const payload = (await response.json()) as {
        metadata?: { duration?: number }
        results?: {
            channels?: Array<{
                detected_language?: string
                alternatives?: Array<{ transcript?: string }>
            }>
        }
    }

    const channel = payload.results?.channels?.[0]
    const text = channel?.alternatives?.[0]?.transcript ?? null

    return {
        text: text && text.length > 0 ? text : null,
        model: config.deepgram.model,
        language: channel?.detected_language ?? config.deepgram.language,
        duration: payload.metadata?.duration ?? null,
        error: null
    }
}
