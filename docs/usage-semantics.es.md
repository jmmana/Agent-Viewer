# Semántica de consumo: qué significa una cifra de tokens o costo

Esta es la referencia única y vinculante de lo que significa un conteo de tokens, un costo o una moneda en
cualquier parte de Agent Viewer: el servidor, el portal, la CLI, los SDK y la librería integrable. Cualquier otro
documento enlaza aquí en lugar de repetir las reglas. English: [usage-semantics.md](usage-semantics.md).

Lee esto antes de reportar consumo desde tu propio runtime, antes de leer una respuesta de `GET
/api/v1/snapshot` o `GET /api/v1/usage`, y antes de conciliar una cifra que muestra Agent Viewer contra una
factura de tu proveedor.

## 1. Reglas vinculantes

- **U1. Lo desconocido nunca se muestra ni se guarda como cero.** Aplica al servidor, al portal, a la CLI y a
  los SDK. Un conteo de tokens, un costo o una moneda que no se reportó se queda desconocido (`null` o ausente);
  nunca se escribe, se suma ni se muestra como `0`. Esta es la forma general del principio 6 del README
  ("Desconocido no es cero, en ningún lado"), que a su vez repite la regla propia del componente integrable,
  principio 4 ("El componente nunca calcula, suma ni pone precio al consumo. Un costo que falta se muestra como
  desconocido, nunca como 0").
- **U2. El componente integrable nunca inventa, suma ni pone precio al consumo.** `<AgentOffice>` solo muestra
  las cifras que el host pasa por las props `usage` / `showUsage`; `showUsage` es `false` por defecto. La ayuda
  opcional `summarizeUsage(events)` es la única excepción: suma lo que reportaron los eventos `llm.usage`, y
  nunca pone precio a nada. Ver [docs/library.es.md](library.es.md#cifras-de-consumo).
- **U3. Los costos en monedas distintas nunca se suman ni se convierten.** Un monto en USD y uno en EUR se
  quedan en bolsas separadas en todas partes: `usage.total.byCurrency` del servidor, el `summarizeUsage` de la
  librería y el portal. Agent Viewer no tiene tabla de tipo de cambio y no la tendrá en esta capa.
- **U4. Los costos reportados y los estimados nunca se combinan en una sola cifra.** `costSource` es parte de
  la clave de cada suma en todas partes donde se suma un costo: un monto `provider-reported` en USD y uno
  `estimated` en USD son dos entradas separadas, nunca una suma.
- **U5. La agregación del lado del servidor está permitida.** El reductor del servidor
  (`server/usageAggregates.ts`) suma tokens y costos llamada por llamada, pero debe cumplir U1, U3 y U4, y debe
  decir qué cubre (ver [sección 9](#9-qué-cubre-un-total)): qué eventos, desde cuándo, y si algo se descartó.

## 2. Referencia de campos de `llm.usage`

Esquema: `LlmUsagePayloadSchema` en
[`src/integrations/canonicalContract.ts`](../src/integrations/canonicalContract.ts).

| Campo | Tipo | Cómo se representa "desconocido" | Significado |
|---|---|---|---|
| `provider` | `string` (obligatorio) | no aplica, siempre obligatorio | El nombre propio del proveedor, como lo nombra tu runtime (`"Anthropic"`, `"OpenAI"`...). Texto libre, no un enum: también es la primera mitad de la clave de deduplicación `(provider, requestId)`. |
| `model` | `string` (obligatorio en `llm.usage`; opcional en `llm.failed`) | `null` solo en `llm.failed` | El modelo realmente llamado. En `llm.failed`, `null` significa que la llamada falló antes de elegir un modelo (por ejemplo, un fallo de conexión). |
| `inputTokens` | entero no negativo (obligatorio) | no aplica, siempre obligatorio en `llm.usage`; opcional en `llm.failed` | Todos los tokens de entrada que procesó el proveedor, **incluyendo** `cacheReadTokens` y `cacheWriteTokens`. Ver [sección 6](#6-lectura-de-caché-frente-a-escritura-de-caché). |
| `outputTokens` | entero no negativo (obligatorio en `llm.usage`; opcional en `llm.failed`) | opcional en `llm.failed` | Tokens que produjo el modelo, incluyendo tokens de razonamiento cuando el proveedor los cobra como salida. |
| `cacheReadTokens` | entero no negativo o `null` | ausente o `null` | Parte de `inputTokens` servida desde la caché de prompts del proveedor (acierto de caché). |
| `cacheWriteTokens` | entero no negativo o `null` | ausente o `null` | Parte de `inputTokens` escrita en la caché de prompts del proveedor (creación de caché). |
| `cachedTokens` | entero no negativo o `null` (**obsoleto**) | ausente o `null` | Alias heredado de `cacheReadTokens`. Todavía se acepta, se guarda en el payload tal como se envió, y se copia a `cacheReadTokens` cuando ese campo está ausente. Un número distinto en ambos se rechaza. Los nuevos emisores deben usar `cacheReadTokens` directamente. |
| `reasoningTokens` | entero no negativo o `null` | ausente o `null` | Tokens gastados en razonamiento privado que el proveedor cobra y reporta por separado de la salida visible. |
| `latencyMs` | entero no negativo o `null` | ausente o `null` | Duración de la llamada en milisegundos, medida por quien la reporta. |
| `requestId` | `string` o `null` | ausente o `null` | El id de solicitud o respuesta propio del proveedor, el mismo que aparece del lado del proveedor o en una exportación de facturación. Alimenta la clave de deduplicación `(provider, requestId)` (ver [sección 8](#8-deduplicación)). Nunca un contador sintético reutilizado entre sesiones. |
| `cost` | número no negativo o `null` | `null` (por defecto) | El monto de esta llamada, en la unidad de `currency`. `null` significa que no se conoce ningún costo para esta llamada, no "gratis". |
| `costSource` | `"provider-reported"` \| `"estimated"` \| `"unknown"` | `"unknown"` (por defecto) | De dónde viene `cost`. Ver [sección 5](#5-significados-de-costsource). |
| `currency` | código ISO 4217 (`^[A-Z]{3}$`) o `null` | ausente o `null` | La unidad de `cost`. Un `cost` sin una `currency` válida se conserva, pero se cuenta aparte (ver [sección 4](#4-monedas)). |

`llm.failed` lleva los mismos campos de tokens, costo, `costSource` y `currency` (todos opcionales, porque la
mayoría de las llamadas fallidas no reportan nada), más `errorKind`, `httpStatus`, `retryable`,
`providerErrorCode` y `attempts`. Referencia completa:
[docs/integration.md](integration.md#-7-canonical-llm-usage-normalization).

## 3. Desconocido frente a cero

```json
{ "reasoningTokens": 0 }
```

significa "el proveedor dijo cero": una llamada que de verdad no gastó tokens en razonamiento privado.

```json
{ "reasoningTokens": null }
```

o el campo omitido por completo, significa "no reportado": quien lo envía no lo sabe, porque el proveedor no
reporta esta cifra para esta llamada, o porque quien la reporta todavía no lo conectó. Agent Viewer nunca
convierte el segundo caso en el primero.

La misma distinción aplica a `cost`: `cost: 0` significa que el proveedor cobró exactamente cero (una llamada de
nivel gratuito, una respuesta solo de caché que algunos proveedores no cobran); `cost: null` significa que no se
conoce ningún monto. La propia telemetría de Claude Code es un ejemplo real de por qué esto importa: reporta
`cost_usd: 0` cuando no puede poner precio a una llamada, no cuando la llamada fue gratis (ver
[docs/claude-code.md](claude-code.md#tokens-and-cost)). El receptor nunca reescribe ese `0` como `null`, porque el
`0` de Claude Code de verdad es lo que envió; esto es una arista particular de esa fuente de telemetría concreta,
no una regla que Agent Viewer aplique en otro lado.

**Cómo muestra un agregado el conocimiento parcial.** El `UsageBucket` del servidor
(`server/usageAggregates.ts`) nunca reporta una suma junto a un relleno silencioso de ceros. Cada tipo de token
tiene:

```json
{ "sum": 1500, "unreportedCount": 2 }
```

`sum` es `null` hasta que alguna llamada en la bolsa reporta ese tipo; una vez que alguna lo hizo, `sum` es el
total solo de las llamadas que lo reportaron, y `unreportedCount` dice cuántas llamadas de la misma bolsa no lo
hicieron. Nunca se debe dividir `sum` entre `calls` y llamar al resultado "tokens por llamada" cuando
`unreportedCount > 0`: es tokens por llamada entre las que reportaron la cifra. El portal lo muestra como la suma
conocida más una nota de "N llamadas sin reportar" al lado, nunca mezclada dentro del número.

## 4. Monedas

- Solo se aceptan códigos ISO 4217 (`^[A-Z]{3}$`, por ejemplo `USD`, `EUR`, `COP`). Un valor en texto libre como
  `"usd"`, `"dólares"` o una cadena vacía no cuenta como moneda.
- Los totales son por moneda. `usage.total.byCurrency` es un arreglo de pares `(currency, costSource)`, nunca
  una sola cifra.
- Un costo sin moneda, o con una inválida, va a su propio contador (`currencyMissingCount` en el servidor,
  `costWithoutCurrency` en la librería) en lugar de mezclarse en cualquier entrada de `byCurrency` o asumirse como
  USD.
- Agent Viewer nunca convierte entre monedas, en ningún lado. No hay tabla de tipo de cambio en esta capa ni
  está planeada antes de que llegue el precio (0.6.0, fuera del alcance de esta guía).

## 5. Significados de `costSource`

| Valor | Significado | Quién puede ponerlo |
|---|---|---|
| `provider-reported` | El proveedor devolvió este monto para esta llamada específica (en el cuerpo de la respuesta o en una API de facturación). Agent Viewer lo guarda como reportado y no lo verifica contra tu factura. | Tu runtime o adaptador; los SDK solo cuando quien llama lo indica explícitamente. |
| `estimated` | Calculado a partir de tokens y una lista de precios, por el runtime o el adaptador, o (más adelante, 0.6.0) por una tabla de precios del servidor. La propia telemetría `cost_usd` de Claude Code se recibe como `estimated`: es la estimación propia de Claude Code hecha en tu máquina, no tu factura de Anthropic. | Tu runtime o adaptador; el mapeo de telemetría de Claude Code en la CLI. |
| `unknown` | No se conoce ningún costo para esta llamada. `cost` debe ser `null`. Es el valor por defecto: un `cost` enviado sin indicar `costSource` se registra como `unknown`, no se adivina como `provider-reported`. | Por defecto, siempre que no se indique otra cosa. |

**Historia.** Antes del issue #58, tanto el SDK de Python como el de TypeScript etiquetaban cualquier costo que
recibían como `provider-reported` por defecto, incluso cuando quien llamaba en realidad había calculado una
estimación. A partir de 0.3.0, un `cost` dado sin `cost_source` / `costSource` se envía como `unknown`, y cada
cliente del SDK imprime una advertencia (Python: `logging.WARNING` en el logger `agent_viewer`; TypeScript:
`console.warn`). **Para corregir registros antiguos:** los eventos guardados antes de este cambio que tienen
`costSource: "provider-reported"` pero vinieron de código que nunca lo indicó explícitamente no se corrigen de
forma automática (Agent Viewer nunca reescribe eventos guardados); trata cualquier costo `provider-reported` de
antes de actualizar tu SDK como sospechoso a menos que sepas que tu código siempre pasó `cost_source`
explícitamente, y vuelve a emitir eventos `llm.usage` corregidos con el mismo `requestId` si necesitas arreglar
la cifra hacia adelante (ver [deduplicación](#8-deduplicación): un reenvío corregido con un `requestId`
distinto es una llamada nueva, no una corrección de la anterior).

## 6. Lectura de caché frente a escritura de caché

Los proveedores cobran una lectura de caché (servir un prompt desde su caché) y una escritura de caché (crear
esa entrada de caché) a tarifas distintas, a menudo mucho más baratas para las lecturas. Agent Viewer las
registra por separado y nunca pone precio a ninguna de las dos.

**`inputTokens` incluye los tokens de caché.** Por la convención fijada en el issue #46 y usada por el receptor
OTLP (#59) y por la propia validación del contrato (`cacheReadTokens + cacheWriteTokens` no puede superar
`inputTokens`), `inputTokens` es la contabilidad *total* de entrada del proveedor, caché incluida. Esto coincide
exactamente con la API de Messages de Anthropic (`input_tokens` se cobra por separado de
`cache_read_input_tokens` y `cache_creation_input_tokens`, así que un adaptador debe sumar los tres en
`inputTokens`) y con la contabilidad propia de OpenAI (`prompt_tokens` / `input_tokens` ya incluyen la parte en
caché, reportada de nuevo por separado solo como un desglose). El supuesto del simulador de Model Ops de que los
tokens de caché son un subconjunto de los tokens de entrada (`src/engine/modelOps.ts`) se cumple bajo esta
convención.

**Mapeo de campos por proveedor.** La tabla completa, con los nombres de campo propios de cada proveedor y la
referencia de API verificada contra la documentación actual de cada uno, vive en
[docs/integration.md](integration.md#mapping-provider-usage-fields) para que haya exactamente una copia que
mantener al día. Resumen: `cache_read_input_tokens` y `cache_creation_input_tokens` de Anthropic se mapean
directamente a `cacheReadTokens` y `cacheWriteTokens`; `prompt_tokens_details.cached_tokens` de OpenAI (Chat
Completions) se mapea a `cacheReadTokens`, sin ninguna cifra de escritura de caché reportada (deja
`cacheWriteTokens` fuera, nunca `0`).

**Claude Code.** El receptor de telemetría OTLP (`POST /v1/logs`, [docs/otlp.md](otlp.md)) mapea los atributos
propios de Claude Code `cache_read_tokens` y `cache_creation_tokens` a `cacheReadTokens` y `cacheWriteTokens`, y
los suma (junto con el `input_tokens` crudo) al `inputTokens` reportado, ya que el atributo `input_tokens` propio
de Claude Code excluye el uso de caché (lo opuesto a la convención de arriba). Este es el único lugar del código
donde el receptor, y no el proveedor, hace la suma; está documentado como una excepción explícita en
[docs/claude-code.md#tokens-and-cost](claude-code.md#tokens-and-cost).

## 7. `llm.failed`

Emite `llm.failed` para un **intento** fallido de llamada al modelo: un error del proveedor, un límite de
tasa, un tiempo de espera agotado o una cancelación del cliente. Un reintento que después tiene éxito es un
evento `llm.usage` separado con su propio id (y, cuando el proveedor da uno, su propio `requestId`).

**Campos**, tal como los entregó el issue #46: `provider` (obligatorio), `model` (opcional: un fallo de conexión
puede ocurrir antes de elegir un modelo), `errorKind` (uno de `LLM_ERROR_KINDS`: `rate_limited`, `overloaded`,
`timeout`, `invalid_request`, `auth`, `server_error`, `cancelled`, `network`, `unknown`), `httpStatus`,
`retryable`, `requestId`, `providerErrorCode`, `attempts`, además de los mismos campos de tokens, costo,
`costSource` y `currency` que `llm.usage`, todos opcionales. Deliberadamente no hay un campo de mensaje de error
en texto libre: el texto de error del proveedor puede contener prompts o credenciales.

**Cómo cuenta.** Las llamadas `llm.failed` se cuentan aparte, bajo `failed` en cada bolsa de
`server/usageAggregates.ts` (`total.failed`, el `failed` de cada modelo, el `failed` de cada agente), nunca
mezcladas con los totales exitosos. Los tokens y el costo de una llamada fallida cuentan solo cuando el proveedor
realmente cobró el intento (la mayoría no lo hace): una llamada fallida sin consumo reportado **nunca** se trata
como una llamada de costo cero, es una llamada cuyo costo es desconocido, igual que cualquier otra cifra sin
reportar. `llm.failed` no cambia el estado del agente en la oficina (un intento fallido suele reintentarse) ni
cambia el estado que maneja `agent.status.changed`; solo registra al agente si es nuevo y guarda su proveedor y
modelo.

## 8. Deduplicación

- **Idempotencia del `id` del evento.** Un `id` nombra exactamente un evento, para siempre. El servidor calcula
  una huella (`fingerprint`, `sha256:` sobre el evento validado, con las llaves ordenadas y los valores por
  defecto llenados) de cada evento guardado. El mismo `id` con la misma huella es un reintento verdadero (`200
  duplicate`, nada se vuelve a contar). El mismo `id` con una huella *distinta* es un `409
  conflicting_duplicate`: el contenido nuevo se rechaza por completo, no se combina ni se aplica parcialmente.
- **Deduplicación por `requestId` para `llm.usage` y `llm.failed`** (issue #48). Además de la clave `id`, estos
  dos tipos comparten una segunda clave: `(provider, requestId)`, normalizada (proveedor recortado y en
  minúsculas, `requestId` recortado). "Misma llamada" significa el mismo id de solicitud o respuesta del
  proveedor, sin importar qué `id` haya usado un reintento, un búfer reproducido, dos capas de reporte (un
  adaptador y código escrito a mano) o una entrega de webhook reenviada. Un segundo reporte bajo la misma clave
  se guarda como una referencia auditable `duplicateOf`: nunca se suma a ningún total, nunca se retransmite por
  SSE, y se excluye de `GET /api/v1/events`, pero sigue siendo inspeccionable en `GET
  /api/v1/usage/duplicates`. `llm.usage` y `llm.failed` comparten un solo espacio de claves, así que una llamada
  reportada como fallida y luego como usada bajo el mismo `requestId` no se cuenta dos veces.
- **Reintentos de webhook** (issue #49). El webhook genérico deriva un id de evento determinista a partir de la
  clave de idempotencia de la entrega (un encabezado `Idempotency-Key`, un campo `idempotencyKey` en el cuerpo, o
  su firma HMAC), así que un reintento idéntico cae en el mismo `id` y se resuelve como un duplicado ordinario.
  Una entrega sin clave de idempotencia recibe un id aleatorio y se marca `source: "none"`: no es seguro
  reintentarla a ciegas, porque el servidor no puede distinguir un reintento de un segundo evento real.

## 9. Qué cubre un total

- **SQLite.** Cada total se reconstruye desde la base de datos al iniciar el servidor (issue #52): el servidor
  reproduce cada evento guardado, en orden de inserción, a través del mismo reductor que usa el camino en vivo,
  así que el estado después de reiniciar es idéntico al estado anterior. `GET /ready` responde `503
  store_rebuilding` hasta que termina la reproducción. `retention.maxEvents` siempre es `null` en este modo: la
  base de datos conserva cada fila, nada se descarta.
- **Modo en memoria (el valor por defecto).** La ventana de eventos retenidos es un búfer circular limitado por
  `AGENT_VIEWER_MAX_EVENTS` (por defecto `10000`; issue #53). Pasado ese límite, los eventos más antiguos se
  descartan de la lista que devuelven `GET /api/v1/events` y la repetición SSE, **pero los totales y las cifras
  por agente no se reducen**: siguen contando cada evento aceptado desde que arrancó el proceso, descartes
  incluidos. `snapshot.retention` (también en `GET /api/v1/events` y el latido SSE) reporta `storage`,
  `maxEvents`, `retainedEvents`, `acceptedEvents`, `droppedEvents` y `since`, así que quien lee siempre puede
  saber cuándo la lista de eventos es una ventana truncada aunque los totales no lo sean. La deduplicación
  tampoco olvida: el id de un evento descartado (y, para `llm.usage`/`llm.failed`, su clave `(provider,
  requestId)`) se mantiene conocido durante toda la vida del proceso, así que un reintento tardío de algo
  descartado hace tiempo sigue reconociéndose como duplicado y nunca se vuelve a contar.
- **Reconexión y resincronización SSE** (issue #54). Un cliente que se reconecta y perdió eventos los recibe
  reproducidos por completo hasta `AGENT_VIEWER_SSE_REPLAY_MAX` (por defecto `10000`); más allá de eso, o cuando
  el cursor mismo es desconocido (nunca se guardó, se descartó, o se perdió tras un reinicio en modo memoria), el
  servidor envía un cuadro `resync` explícito en lugar de una repetición parcial silenciosa, con `missed` como un
  conteo o `null` cuando de verdad se desconoce, nunca `0`. Ante un `resync`, un cliente debe reconstruir sus
  cifras de consumo desde los agregados propios del snapshot (`usage`, no `totalTokens`/`totalCost`), nunca
  sumando de nuevo la lista de eventos (limitada) del propio snapshot.
- **`PATCH /api/v1/agents/:agentId` ya no puede cambiar el gasto** (issue #50). Solo se aceptan campos
  descriptivos de perfil y estado; un campo de consumo o costo en el cuerpo se rechaza con `400
  validation_failed`. La única forma de reportar consumo es un evento `llm.usage` (o `llm.failed`).
- **Las marcas de tiempo son del reloj del cliente.** `event.timestamp` es lo que dijo el reloj de quien lo
  envía, no cuándo lo recibió el servidor; `firstTimestamp`/`lastTimestamp` de una bolsa reflejan eso. Un campo
  de hora de recepción del servidor está planeado (issue #65, fuera de alcance aquí) y todavía no existe: no
  asumas que `timestamp` ordena los eventos como el servidor realmente los vio bajo desfase de reloj o retraso de
  red.

## 10. De dónde sale cada cifra en pantalla

| Dónde | Fuente | Notas |
|---|---|---|
| Insignia o panel de consumo de la librería (`<AgentOffice showUsage usage={...}>`) | Lo que el host pase en la prop `usage` | La librería nunca lo calcula (U2). Sin prop, sin panel. |
| Librería, `summarizeUsage(events)` | El propio arreglo `events` del host, leído del lado del cliente | Solo opcional; deduplica por `id` de evento; nunca pone precio. |
| Barra superior del portal (modo en vivo) | El bloque `usage` de `GET /api/v1/snapshot` / SSE del servidor | Nunca se vuelve a derivar de la propia lista de eventos del portal, así que coincide exactamente con el servidor, descartes incluidos en modo memoria. |
| Consola de Model Ops, cifras "en vivo" | Los mismos agregados `usage` del servidor, por proveedor y modelo | Solo datos reales; nunca mezclados con el simulador. |
| Consola de Model Ops, pestaña Simulador | Una calculadora local de qué pasaría si, sobre el catálogo de precios de la demo | Siempre marcada `simulated: true` y mostrada con una insignia `SIMULADO`; nunca toca los tokens o el costo reales de un agente, y no se renderiza como una acción contra un agente real en modo en vivo. Un modelo fuera del catálogo (por ejemplo el modelo real de un agente en vivo) muestra "Desconocido", nunca un precio de respaldo. |
| Hooks de Claude Code (sin `--telemetry`) | Nada: los hooks nunca llevan tokens ni costo | Una sesión de Claude Code vista solo por hooks muestra correctamente `0.0K` / sin reportar, no una adivinanza. |
| Tokens y costo de Claude Code | `install claude-code --telemetry`, los registros propios de OpenTelemetry de Claude Code, recibidos en `POST /v1/logs` | `costSource: "estimated"` siempre (la estimación propia de Claude Code hecha en tu máquina, ver [sección 5](#5-significados-de-costsource)); las cifras cubren solo lo que la oficina realmente recibió mientras la telemetría estaba activa y la oficina corriendo. |

## 11. Conciliar con una factura

1. **Lee `GET /api/v1/usage` (o el bloque `usage` del snapshot), no los obsoletos `totalTokens`/`totalCost`.**
   Los campos obsoletos son cotas inferiores o `null` por diseño; el bloque `usage` es el que tiene las cifras
   por moneda y por `costSource`.
2. **Agrupa por moneda y por `costSource` antes de comparar nada.** Tu factura está en una moneda; compárala
   contra la única entrada de `byCurrency` con esa moneda y `costSource: "provider-reported"`. Nunca sumes entre
   entradas de `byCurrency`.
3. **No restes nada por llamadas fallidas a menos que tu factura lo haga.** Revisa `total.failed`: la mayoría de
   los proveedores no cobran un intento fallido, pero algunos cobran consumo parcial en una respuesta
   `rate_limited` o `timeout`. `failed.tokens` y `failed.byCurrency` se guardan aparte justamente para que puedas
   revisarlo en lugar de adivinar.
4. **Ten en cuenta `costUnknownCount` antes de concluir que los totales no coinciden.** `costMissingCount`
   (ningún costo reportado) y `currencyMissingCount` (un costo reportado sin moneda utilizable) son llamadas
   cuyo monto no está en ninguna entrada de `byCurrency`. Un conteo distinto de cero aquí, no un error de código,
   suele ser la razón de que una suma parezca corta frente a la factura.
5. **Revisa `retention` en modo memoria.** Si `droppedEvents > 0`, la *lista* de eventos es una ventana
   truncada, pero los totales que estás conciliando siguen cubriendo todo desde `totalsSince` (ver [sección
   9](#9-qué-cubre-un-total)). Si necesitas el detalle a nivel de evento y la ventana ya lo descartó, cambia a
   `AGENT_VIEWER_STORAGE=sqlite` antes de la ventana que te interesa.
6. **Corre la suite dorada como la forma ejecutable de esta guía.** `npm run test:golden` (issue #62) revisa un
   fixture elaborado a mano contra el almacén en memoria, el almacén SQLite tras un reinicio, el portal y la
   librería, y confirma que los cuatro llegan a las mismas cifras. Por ejemplo, sus 7 llamadas exitosas más 1
   fallida (tras resolver 2 duplicados y 1 duplicado en conflicto) concilian a `input: 3300`
   (`unreportedCount: 0`), `output: 860` (`unreportedCount: 0`), `cacheRead: 300` y `cacheWrite: 50`
   (`unreportedCount: 1` cada uno, de la única llamada que de verdad no los reportó), costo `USD 0.0225` más
   `EUR 0.0200` (nunca sumados), una llamada con costo desconocido y una con costo pero sin moneda utilizable.
   Ver [`tests/fixtures/reconciliation/README.md`](../tests/fixtures/reconciliation/README.md) para la
   aritmética completa, línea por línea.
