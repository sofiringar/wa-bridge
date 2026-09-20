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

## Credenciales portables

Emparejas el telefono **una vez** y te llevas la sesion a otro ambiente (contenedor, CI,
otra maquina) como una sola cadena base64, sin volver a escanear el QR.

```bash
npm run creds:export
```

Escribe `data/wa-creds.b64` (modo `600`) y resume que viaja dentro:

```
credenciales exportadas -> /ruta/data/wa-creds.b64
  cuenta        5215500001111:12@s.whatsapp.net — Sofia
  sesiones      default
  sqlite podado 96.0 KB -> gzip 4.6 KB -> base64 6256 chars
  tablas        auth_credentials=1 signal_identity=15 signal_meta=1 signal_prekey=60 ...
```

En el otro ambiente, define **una** de estas dos variables:

| Variable | Contenido |
|---|---|
| `WA_CREDS` | El blob base64 en la propia variable |
| `WA_CREDS_FILE` | La ruta a un archivo que lo contiene |

```bash
export WA_CREDS="$(cat data/wa-creds.b64)"
npm run daemon          # arranca ya emparejado, sin QR
```

El daemon las rehidrata **solo si no existe `data/auth.sqlite`**: un store local siempre
gana, porque reimportar por encima de una sesion viva la rompe. Tambien puedes
materializarlas a mano:

```bash
npm run creds:import              # desde WA_CREDS / WA_CREDS_FILE
npm run creds:import -- --in data/wa-creds.b64 --force
```

### Que viaja y que no

Se exporta `data/auth.sqlite` entero **menos el contenido** del buzon de historial
(`mailbox_*`), los caches reconstruibles, las colas de reintento y las versiones de
app state — de ahi que un store de 16 MB quepa en ~6 KB de base64. Esas tablas viajan
**vacias, no eliminadas**: `wa_migrations` viaja intacta, asi que el store que importe
da por aplicadas sus migraciones y nunca volveria a crearlas. Lo que si viaja con datos
es todo el material criptografico: credenciales Noise, identidad, prekeys, sesiones y
claves Signal (incluidas las de app state), mas `wa_migrations`.

Al importar, si el blob viene de una version antigua que si eliminaba esas tablas, se
recrean copiando el esquema de un store recien migrado. El daemon repite la
comprobacion al arrancar, asi que un `data/auth.sqlite` ya materializado tambien se
repara.

La copia se hace con `VACUUM INTO`, que toma una instantanea consistente **aunque el
daemon este corriendo**; copiar el `.sqlite` a pelo dejaria cambios sin checkpoint en el
`-wal` y produciria un store vacio o corrupto.

`WA_CREDS` cabe en una variable de entorno normal (el tope en Linux ronda los 128 KB); si
tu export se acerca a ese limite, el CLI te avisa y te dice que uses `WA_CREDS_FILE`.

> **El blob es una credencial completa**: da acceso total a la cuenta de WhatsApp, sin
> segundo factor. Trátalo como una contraseña — secreto de CI, nunca en el repo. Está en
> `.gitignore`, y para revocarlo basta con cerrar el dispositivo vinculado desde el
> teléfono.

---

## Comprobacion sin WhatsApp

```bash
npm run selftest
```

Mete protobufs sintéticos (texto, cita, imagen con miniatura, nota de voz, mensaje
efímero, mensaje de protocolo, encuesta) por el mismo camino que usa la reconciliación
del buzón y comprueba el resultado en la base: tipos, `quotedId`, poda de miniaturas,
idempotencia y filtrado por rango. Útil para validar un ambiente nuevo antes de
emparejar, o tras tocar `extract.ts` / `codec.ts`. Usa `DATA_DIR` para no pisar tu
archivo real:

```bash
DATA_DIR=/tmp/wa-selftest npm run selftest
```

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

**Que trae y que no trae una sesion restaurada**: el volcado del historial solo se
emite **al emparejar**, y WhatsApp no lo repite, asi que un ambiente que arranca desde
`WA_CREDS` reanuda la sesion pero sin archivo. No hace falta forzar nada: al reconectar,
el servidor descarga la rafaga de lo acumulado mientras el dispositivo estuvo fuera
(*offline resume*) y esos mensajes entran por el evento `message` como los de en vivo.
Lo que esa rafaga no trae, el daemon lo pide una sola vez con el archivo vacio: la lista
de grupos (consulta al servidor) y el app state con la libreta de contactos. El
historial anterior al emparejamiento no es recuperable sin volver a vincular.

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
| [`src/creds.ts`](src/creds.ts) | Exportación / importación portable de la sesión |
| [`src/creds-cli.ts`](src/creds-cli.ts) | CLI de `creds:export` / `creds:import` |
| [`src/selftest.ts`](src/selftest.ts) | Verificación del pipeline sin WhatsApp |

## Problemas conocidos

- **`Sesión cerrada desde el teléfono`**: borra `data/auth.sqlite` y vuelve a emparejar.
- **Un chat sale vacío**: WhatsApp solo empuja historial reciente al emparejar. Pide un
  rango y deja que el backfill haga su trabajo, o escribe algo en ese chat para que
  entre en el buzón.
- **No abras dos daemons sobre el mismo `data/`**: el store de zapo es de un solo
  escritor.
- **`optional dependency "ws" is not installed`**: zapo declara `ws` como peer
  dependency opcional pero el transporte WebSocket lo necesita siempre. Ya va declarado
  en `package.json`; si ves este error, corre `npm install`.
- **Red restringida**: el daemon necesita WebSocket saliente a `web.whatsapp.com`
  (443 y 5222), `mmg.whatsapp.net` para la media y `api.deepgram.com` para transcribir.
  Detrás de un proxy que no tuneliza WebSocket, el arranque falla con
  `comms connection timeout`; el daemon lo registra y reintenta con backoff en vez de
  morirse.
