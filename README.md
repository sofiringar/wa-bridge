# wa-bridge

Puente local entre WhatsApp y una rutina de Claude Code: le pides un ID de conversación
y un rango de fechas, y te devuelve los mensajes en JSON — con las imágenes accesibles y
las notas de voz transcritas con Deepgram.

Construido sobre [zapo](https://github.com/vinikjkkj/zapo), una implementación no oficial
del protocolo de WhatsApp Web.

> **Aviso**: las implementaciones no oficiales del protocolo pueden derivar en el baneo
> del número. Empareja un número secundario, no el principal.

---

## Cómo funciona

Son **dos procesos sobre dos bases SQLite**:

```
  teléfono ──► daemon ──► data/auth.sqlite     (store de zapo: credenciales + buzón)
                  │
                  └─────► data/wa-bridge.sqlite (tabla normalizada + transcripciones)
                                  ▲
                                  │
                                api ──► HTTP en 127.0.0.1:8787
```

**`daemon`** mantiene la sesión abierta. Los mensajes en vivo llegan por el evento
`message` y se archivan al instante. El historial es distinto: el evento
`history_sync_chunk` de zapo **solo entrega contadores**, no los mensajes — la librería
los persiste en su propio buzón. Por eso el daemon corre una pasada de reconciliación
(`store.messages.listByThread`) tras cada ráfaga de chunks y copia lo nuevo a la tabla
normalizada, que es la que se consulta por rango de fechas.

**`api`** solo lee la base normalizada. No abre sesión ni toca el store de zapo, lo que
respeta la regla de un único escritor por store.

### Las imágenes

No existe una URL de Meta que devuelva la imagen legible: el CDN almacena el archivo
**cifrado** (AES-256-CBC con clave derivada por HKDF de la `mediaKey`), y descifrarlo es
cosa del cliente. Lo que sí es cierto es que ese blob cifrado se descarga **sin
autenticación**, con solo el `directPath`.

Así que `/media/:id` hace streaming desde `mmg.whatsapp.net`, descifra al vuelo y
devuelve el JPEG. **No se guarda ningún binario en disco** salvo que pidas
`?materialize=true`. La contrapartida: el CDN purga los blobs a las pocas semanas, y a
partir de ahí la media antigua devuelve `410`.

Para una rutina de Claude Code, `materialize=true` es lo habitual: una URL de
`127.0.0.1` no sirve para que el modelo *vea* la imagen (`WebFetch` rechaza hosts sin
punto), pero la ruta absoluta que devuelve `media.path` se abre directamente con `Read`.

---

## Puesta en marcha

Requiere **Node 20.11+**.

```bash
npm install
```

```bash
cp .env.example .env
```

Rellena `DEEPGRAM_API_KEY` en `.env` (sin ella todo funciona salvo la transcripción).

Arranca el daemon y escanea el QR desde *WhatsApp > Dispositivos vinculados*:

```bash
npm run daemon
```

Déjalo corriendo. En otra terminal:

```bash
npm run api
```

La primera sincronización tarda unos minutos: WhatsApp empuja el historial reciente en
ráfagas y el daemon lo va copiando. Comprueba el avance con `/health`.

---

## API

Todas las respuestas son JSON. Si defines `API_KEY` en `.env`, manda el header
`x-api-key` en cada petición (`/health` queda exento).

### `GET /health`

Estado del daemon, cobertura temporal del archivo y si Deepgram está configurado.

```bash
curl 127.0.0.1:8787/health
```

### `GET /chats`

Para descubrir los IDs de conversación.

| Parámetro | Por defecto | Descripción |
|---|---|---|
| `q` | — | Filtra por nombre o JID (case-insensitive) |
| `limit` | 50 | Máximo 500 |

```bash
curl "127.0.0.1:8787/chats?q=familia"
```

### `GET /messages`

El endpoint principal.

| Parámetro | Por defecto | Descripción |
|---|---|---|
| `chatId` | **obligatorio** | JID del grupo (`...@g.us`) o del usuario (`...@s.whatsapp.net`) |
| `from` | — | Inicio del rango |
| `to` | — | Fin del rango |
| `limit` | 200 | Máximo 2000 |
| `order` | `asc` | `asc` o `desc` |
| `transcribe` | `true` | Transcribe los audios del rango con Deepgram |
| `materialize` | `false` | Descifra imágenes y audios a disco y devuelve rutas absolutas |

**Fechas**: ISO 8601 completo (`2026-09-01T00:00:00-06:00`) o `YYYY-MM-DD`. Una fecha
suelta se interpreta **en UTC** — inicio del día para `from`, fin del día para `to`. Si
la zona horaria te importa, manda el ISO completo con offset.

```bash
curl "127.0.0.1:8787/messages?chatId=1203630@g.us&from=2026-09-01&to=2026-09-15&materialize=true"
```

```json
{
  "chat": { "id": "1203630@g.us", "name": "Equipo", "kind": "group" },
  "range": { "from": "2026-09-01T00:00:00.000Z", "to": "2026-09-15T23:59:59.999Z", "order": "asc", "limit": 200 },
  "coverage": { "oldest": "2026-08-12T10:03:11.000Z", "newest": "2026-09-19T08:44:02.000Z", "total": 1841 },
  "count": 2,
  "messages": [
    {
      "id": "3EB0A9C1",
      "at": "2026-09-02T17:21:09.000Z",
      "fromMe": false,
      "sender": { "jid": "5215500001111@s.whatsapp.net", "name": "Ana" },
      "type": "image",
      "text": "así quedó el stand",
      "quotedId": null,
      "media": {
        "mimetype": "image/jpeg",
        "fileLength": 184322,
        "width": 1280,
        "height": 960,
        "url": "http://127.0.0.1:8787/media/3EB0A9C1?chatId=1203630%40g.us",
        "path": "C:\\...\\data\\media\\1203630_g.us\\3EB0A9C1.jpg"
      }
    },
    {
      "id": "3EB0A9C2",
      "at": "2026-09-02T17:23:44.000Z",
      "fromMe": false,
      "sender": { "jid": "5215500002222@s.whatsapp.net", "name": "Luis" },
      "type": "audio",
      "text": null,
      "media": { "mimetype": "audio/ogg", "seconds": 14, "ptt": true, "url": "…", "path": "…" },
      "transcript": { "text": "Va, nos vemos el jueves.", "model": "nova-3", "language": "es", "duration": 14.2, "cached": false }
    }
  ]
}
```

**Huecos de cobertura**: si `from` cae antes del mensaje más antiguo archivado, la
respuesta trae `coverage.gap` y el daemon pide automáticamente backfill al teléfono
(`requestHistorySync`). No es instantáneo ni está garantizado — reintenta en unos
minutos.

### `GET /media/:msgId`

Devuelve el archivo descifrado. Acepta `?chatId=` para desambiguar (los IDs de mensaje
solo son únicos dentro de un chat).

- `410` — el CDN ya purgó el blob
- `422` — el mensaje no conserva `directPath`/`mediaKey`

---

## Uso desde una rutina de Claude Code

```bash
curl -s "http://127.0.0.1:8787/messages?chatId=<JID>&from=2026-09-01&materialize=true" > /tmp/chat.json
```

Luego abre cada `media.path` con la herramienta `Read` para que el modelo interprete las
imágenes, y usa `transcript.text` para los audios.

Pide `materialize=false` (el valor por defecto) cuando solo necesites el texto: evita
descargar imágenes que nadie va a mirar.

---

## Alcance

**En el MVP**: texto, imágenes y audios (notas de voz y adjuntos), citas (`quotedId`),
grupos y chats 1:1.

**Archivado pero no servido**: vídeo, documentos y stickers se guardan con su metadata y
su protobuf completo, pero `media.url` viene `null`. Para habilitarlos basta con ampliar
la condición `servable` en [`src/api.ts`](src/api.ts) — el descifrado ya es genérico.

**Fuera**: enviar mensajes, reacciones, encuestas y ubicaciones (se archivan como
`[pollCreationMessage]` y similares), y newsletters.

## Estructura

| Archivo | Responsabilidad |
|---|---|
| [`src/daemon.ts`](src/daemon.ts) | Sesión, reconexión con backoff, reconciliación del buzón, cola de backfill |
| [`src/api.ts`](src/api.ts) | Endpoints HTTP |
| [`src/db.ts`](src/db.ts) | Esquema SQLite y consultas |
| [`src/ingest.ts`](src/ingest.ts) | Normalización de eventos en vivo y de registros del store |
| [`src/extract.ts`](src/extract.ts) | Protobuf de WhatsApp → tipo, texto y metadata de media |
| [`src/codec.ts`](src/codec.ts) | Codificación/decodificación del protobuf archivado |
| [`src/media.ts`](src/media.ts) | Descarga y descifrado desde el CDN de Meta |
| [`src/deepgram.ts`](src/deepgram.ts) | Transcripción |

## Problemas conocidos

- **`Sesión cerrada desde el teléfono`**: borra `data/auth.sqlite` y vuelve a emparejar.
- **Un chat sale vacío**: WhatsApp solo empuja historial reciente al emparejar. Pide un
  rango y deja que el backfill haga su trabajo, o escribe algo en ese chat para que
  entre en el buzón.
- **No abras dos daemons sobre el mismo `data/`**: el store de zapo es de un solo
  escritor.
