# Hoja de ruta de Agent Viewer: observabilidad y auditoría del consumo de agentes

[English](roadmap.md) · [README](README.es.md) · [Changelog](../CHANGELOG.md)

Este es el plan público de las versiones 0.3.0 a 0.8.0. Los elementos de trabajo se citan por id (por ejemplo `v030-1`); los números de issue se agregarán junto a cada id cuando los issues estén publicados. No hay fechas a propósito: una versión sale cuando cumple sus criterios de salida, no antes.

## Visión

Agent Viewer pasa a ser una herramienta real de observabilidad y auditoría de los tokens y el costo que consumen los agentes de IA, y la oficina sigue siendo la vista protagonista. Nadie más muestra a los agentes trabajando en una oficina virtual, así que la meta es que veas quién gasta, sentado en su escritorio, y que además puedas demostrar que las cifras son correctas.

En concreto, con la 0.8.0 podrás:

- Preguntar "cuánto gastó el agente X con el modelo Y esta semana" y obtener una cifra por moneda que puedes exportar y conciliar con la factura del proveedor.
- Ver el gasto donde ocurre en la oficina: una insignia por agente, el detalle de cada llamada al hacer clic, el costo por reunión y por herramienta.
- Confiar en que el historial no se tocó, con una cadena de hashes verificable y acceso de auditor de solo lectura, en tu propio servidor.

## Dónde estamos hoy (0.2.1)

La parte visual está terminada y el formato de evento ya trae todo lo necesario: proveedor, modelo, tokens de entrada, salida, caché y razonamiento, latencia, id de la petición, costo, origen del costo y moneda. Sin embargo, hoy las cifras de tokens y costo se comportan como un contador en vivo, no como una herramienta de auditoría. Estas son las brechas conocidas que la 0.3.0 cierra antes de construir nada encima:

- Con SQLite los totales viven solo en memoria y vuelven a cero tras un reinicio.
- Un costo ausente se suma como 0, un `cachedTokens` o `reasoningTokens` ausente se lee como 0 y las monedas distintas se suman entre sí.
- Un `PATCH` sobre un agente puede cambiar los totales de tokens y costo sin producir ningún evento.
- Todo el historial de un agente se carga al último modelo que usó.
- Un id de evento reenviado con contenido distinto se acepta como "duplicado" sin compararlo, los ids generados por el servidor pueden chocar con llamadas simultáneas y un webhook reintentado cuenta dos veces.
- En el modo memoria por defecto, los eventos que pasan el tope se descartan mientras los totales siguen contándolos, y una reconexión SSE reenvía como máximo 100 eventos perdidos.
- Model Ops mezcla llamadas simuladas con datos reales y usa el precio de otro modelo cuando no conoce uno.
- La librería integrable es honesta al no inventar cifras, pero `summarizeUsage` todavía reporta USD cuando se mezcla un costo en USD con un costo sin moneda, y cuenta dos veces un id de evento repetido.

Por esto no habrá lanzamiento público (por ejemplo, Show HN) hasta cerrar la 0.3.0. Una demo con totales que se contradicen haría daño al proyecto justo en su tema central.

## Principios

Estas reglas aplican a cada elemento de trabajo. Un cambio que rompa una de ellas no se publica.

1. **Lo desconocido nunca es cero.** Un valor ausente (costo, moneda, tokens de caché, tokens de razonamiento, latencia) se cuenta como desconocido y se muestra como "desconocido". La regla general del [README](README.es.md#-cómo-contribuir) ("nunca mostrar una cifra desconocida como cero") es obligatoria para el servidor y el portal. La regla 4 del README, sobre el componente integrable, se mantiene igual.
2. **Sin precios inventados ni dinero mezclado.** El servidor nunca convierte monedas, nunca usa el precio de otro modelo cuando falta un precio y nunca suma monedas distintas. El costo reportado y el costo estimado son cifras separadas y nunca se funden en un solo número.
3. **Privacidad por diseño.** Agent Viewer registra lo observable, nunca el razonamiento privado del modelo. El libro de consumo guarda solo metadatos, nunca texto de prompts ni de mensajes. El texto libre se censura en el servidor antes de guardarse, transmitirse o exportarse. Los paneles de consumo de la librería están ocultos salvo que el anfitrión los active.
4. **La librería muestra, el anfitrión calcula.** El componente integrable nunca inventa, suma ni pone precio al consumo. Toda cifra (insignia, detalle de llamada, estado de presupuesto) llega ya calculada desde el anfitrión mediante props. La agregación en el servidor está permitida y es la fuente del portal.
5. **Auditabilidad.** Nada cambia un total sin un evento. Los duplicados se detectan y los duplicados en conflicto se rechazan, nunca se aplican. Toda cifra se puede rastrear hasta las filas que la producen y, desde la 0.8.0, el propio historial es a prueba de manipulación.

## Resumen de versiones

El esfuerzo es el tamaño relativo de toda la versión: S pequeño, M mediano, L grande, XL muy grande.

| Versión | Tema | Esfuerzo |
|---|---|---|
| [0.3.0](#030-cifras-ciertas) | Cifras ciertas | L |
| [0.4.0](#040-libro-de-consumo) | Libro de consumo | L |
| [0.5.0](#050-gasto-visible-en-la-oficina) | Gasto visible en la oficina | M |
| [0.6.0](#060-precios-y-control) | Precios y control | M |
| [0.7.0](#070-captura-automática-e-interoperabilidad) | Captura automática e interoperabilidad | L |
| [0.8.0](#080-auditoría-formal) | Auditoría formal | XL |

## 0.3.0: Cifras ciertas

### Objetivo

Toda cifra de tokens y costo que muestran el servidor, el portal y la librería es cierta: lo desconocido nunca es cero, las monedas no se mezclan, nada se cuenta dos veces ni se edita sin un evento, los totales sobreviven a un reinicio y las sesiones de Claude Code reportan sus tokens reales mediante sus logs nativos de OpenTelemetry. El PR #42 (CLI de un comando, imagen en GHCR, hooks de Claude Code) sale en esta versión. No hay lanzamiento público (Show HN) antes de cerrar esta versión.

### Criterios de salida

- El PR #42 está integrado en main con CI en verde (lint, suites de node y Vitest, pruebas del SDK de Python, los dos targets de Docker, check:package) y la 0.3.0 se publica en npm, GHCR y PyPI desde la misma etiqueta.
- La suite dorada de conciliación (v030-19) pasa: el mismo fixture produce sumas de costo por moneda, conteos de costo desconocido y sumas de tokens por tipo idénticos en el almacén en memoria, en el almacén SQLite antes y después de un reinicio, en el reductor del portal y en `summarizeUsage` de la librería.
- Con SQLite y 10 000 eventos `llm.usage` guardados, el bloque `usage` de `GET /api/v1/snapshot` es idéntico antes y después de reiniciar el servidor (una prueba comprueba igualdad profunda).
- Un corpus de pruebas demuestra que ninguna ruta convierte un costo ausente, ni un `cachedTokens` o `reasoningTokens` ausente, en 0: cada valor ausente incrementa un contador explícito de desconocidos y se muestra como "desconocido" en el portal y en la librería.
- `PATCH /api/v1/agents/:id` con cualquier campo de tokens o costo responde 400 y deja todos los totales intactos.
- Reenviar un id de evento con contenido distinto responde 409; reenviar contenido idéntico responde duplicado; dos eventos `llm.usage` con el mismo proveedor y `requestId` cuentan una sola vez; un webhook reintentado 3 veces con el mismo `Idempotency-Key` cuenta una sola vez.
- 200 llamadas simultáneas a `POST /api/v1/agents` producen 200 ids de evento distintos guardados.
- Un cliente SSE que pierde 5000 eventos se reconecta y termina en el mismo estado que una carga nueva de la página (reenvío completo o resincronización explícita).
- Una sesión real de Claude Code configurada con `install claude-code --telemetry` muestra tokens de entrada, salida, lectura de caché y escritura de caché no nulos, más un costo en USD marcado como "estimado" en su agente principal, a menos de 1% del costo de sesión que reporta el propio Claude Code (verificación manual registrada en el PR).

### Elementos de trabajo

| ID | Elemento de trabajo | Esfuerzo | Depende de |
|---|---|---|---|
| `v030-1` | **Integrar el PR #42: CLI de un comando, imagen en GHCR y adaptador de hooks de Claude Code**<br>Terminar los arreglos en curso, rebasar sobre main 0.2.1, conservar el modo embebido y las garantías de privacidad de los hooks (sin leer el transcript, sin argumentos de herramientas, ids de sesión con hash), correr las pruebas nuevas y los dos targets de Docker en CI y hacer squash merge. | M | ninguno |
| `v030-2` | **Migraciones versionadas de SQLite**<br>Reemplazar la comprobación suelta de `PRAGMA table_info` por una tabla `schema_migrations` y migraciones numeradas, solo hacia adelante, dentro de una transacción al arrancar; negarse a arrancar con una base más nueva que el código; probar la actualización de bases 0.1.x y 0.2.x sin pérdida de datos. | M | ninguno |
| `v030-3` | **Contrato de consumo: lo desconocido sigue desconocido, caché leída vs escrita, `llm.failed`**<br>`cachedTokens` y `reasoningTokens` pasan a ser nullish sin valor por defecto 0; agregar `cacheReadTokens` y `cacheWriteTokens` (`cachedTokens` queda como alias obsoleto de lectura); agregar el tipo canónico `llm.failed` con tipo de error, estado, si es reintentable y latencia. | M | ninguno |
| `v030-4` | **Integridad de ingesta: duplicados en conflicto e ids de servidor sin colisiones**<br>Mismo id con contenido idéntico sigue siendo un duplicado idempotente; mismo id con contenido distinto se rechaza con 409 y nunca se aplica; los ids generados por el servidor dejan de usar `Date.now()` y pasan a UUID aleatorios. | M | `v030-2` |
| `v030-5` | **Deduplicar `llm.usage` y `llm.failed` por `requestId`**<br>Una columna indexada `request_id` y su equivalente en memoria: un evento cuyo (proveedor, `requestId`) ya existe se guarda como referencia duplicada y nunca se suma a los totales. | S | `v030-2`, `v030-3`, `v030-4` |
| `v030-6` | **Paridad del webhook de consumo y reintentos idempotentes**<br>El webhook genérico valida el consumo con el mismo esquema que la API de eventos, y los ids de evento que genera pasan a ser deterministas por entrega, de modo que un reintento cuenta una sola vez. | S | `v030-3`, `v030-4` |
| `v030-7` | **Quitar la edición del gasto por `PATCH /agents`**<br>El endpoint acepta solo campos descriptivos; cualquier campo de tokens o costo responde 400 y apunta a `llm.usage`; todo cambio aceptado emite un evento. Se documenta como cambio incompatible. | S | ninguno |
| `v030-8` | **Agregados honestos del servidor, calculados llamada por llamada**<br>Un solo reductor agrega cada `llm.usage` por agente y por (proveedor, modelo) de esa llamada; cada tipo de token guarda una suma y un conteo de eventos que no lo reportaron; el costo se guarda por (moneda, costSource) y un costo ausente incrementa un contador de desconocidos en vez de sumar 0; el snapshot gana un bloque `usage`. | L | `v030-3` |
| `v030-9` | **Reconstruir todo el estado desde SQLite al arrancar**<br>Reproducir los eventos guardados en orden de inserción por el reductor de agregación para reconstruir consumo, agentes, sesiones, runtimes, tareas y reuniones; registrar el tiempo de reconstrucción; `/ready` responde 503 hasta que termine. | M | `v030-2`, `v030-8` |
| `v030-10` | **Modo memoria: sin pérdida silenciosa ni doble conteo tras la expulsión**<br>El conjunto de deduplicación conserva los ids de eventos expulsados, los totales cubren todo evento aceptado desde el inicio, el snapshot expone metadatos de retención y el portal avisa que el historial está truncado. El tope pasa a ser configurable. | S | `v030-8` |
| `v030-11` | **Reconexión SSE: reenviar todo lo perdido o forzar una resincronización**<br>Reemplazar el límite fijo de 100 por un reenvío paginado hasta un máximo configurable; más allá de él, o con un `Last-Event-ID` desconocido, enviar un evento `resync` explícito que `connectEventStream` entrega al host. | M | ninguno |
| `v030-12` | **Los totales del portal siguen la regla de que lo desconocido no es cero**<br>El reductor del portal deja de sumar un costo ausente como 0 y de mezclar monedas; conserva sumas por moneda más contadores de desconocidos, muestra "desconocido" mediante i18n, separa caché leída y escrita y, en modo en vivo, muestra el bloque `usage` del servidor. | M | `v030-3`, `v030-8` |
| `v030-13` | **`summarizeUsage` de la librería: deduplicar por id y desconocido con moneda mezclada o ausente**<br>Ignorar ids de evento repetidos; el costo pasa a desconocido cuando se mezcla una moneda con una moneda ausente; una cifra de entrada o salida ausente es desconocida en vez de sumar 0. El componente mantiene `trackUsage:false`. | S | `v030-3` |
| `v030-14` | **Separar los datos simulados de Model Ops de los reales**<br>Las llamadas simuladas se rotulan SIMULADO en todas partes y nunca entran en totales, feed o matriz reales; un modelo desconocido recibe una estimación nula en vez del precio de gpt-4o; el modo en vivo lee el desglose por modelo del servidor. | M | `v030-8` |
| `v030-15` | **Arreglos de consumo en los SDK de Python y TypeScript**<br>Los dos helpers `usage()` aceptan moneda, id de tarea, tokens de caché leída y escrita y `requestId`; los tokens de caché y razonamiento quedan sin definir por defecto, no en 0; `costSource` es lo que declara quien llama, nunca se afirma como reportado por el proveedor por su cuenta; el `llm_usage` antiguo de Python sigue la misma regla. | M | `v030-3` |
| `v030-16` | **Receptor de logs OTLP/HTTP para la telemetría de tokens de Claude Code**<br>Primero confirmar los nombres de evento y atributos contra la documentación vigente de monitoreo de Claude Code y grabar fixtures reales; agregar `POST /v1/logs` (http/json, misma autenticación que la API) que mapea `api_request` a `llm.usage` (costo en USD con `costSource` "estimated") y `api_error` a `llm.failed`; los tokens caen en el agente principal del hook; los ids se derivan del contenido del registro para que los reintentos sean idempotentes; los atributos de prompt se ignoran. | L | `v030-1`, `v030-3`, `v030-5` |
| `v030-17` | **`install claude-code --telemetry`**<br>Escribir opcionalmente el bloque de variables de OpenTelemetry en `.claude/settings.local.json`, mostrando el diff y preguntando antes, sin activar nunca el registro de prompts; documentar en `docs/claude-code.md` que el costo es la estimación de Claude Code y cómo se atribuyen las llamadas de subagentes. | S | `v030-1`, `v030-16` |
| `v030-18` | **Advertir con claridad cuando la API está abierta sin token**<br>Advertencia al arrancar, `/health` reporta `auth: "open"`, un aviso persistente en el portal y valores por defecto de Docker que publican puertos en 127.0.0.1. La negativa a arrancar llega en v040-8. | S | `v030-1` |
| `v030-19` | **Suite dorada de conciliación**<br>Un fixture de eventos con cifras esperadas conocidas (monedas mixtas, costo ausente, moneda ausente, tokens de caché ausentes, ids duplicados y en conflicto, `requestId` repetido, reintentos de webhook, `llm.failed`, un intento de PATCH) que se ejecuta por el almacén en memoria, SQLite con reinicio, la ruta del webhook, el reductor del portal y la librería, y verifica resultados idénticos en cada PR. | M | `v030-5`, `v030-6`, `v030-7`, `v030-9`, `v030-10`, `v030-12`, `v030-13` |
| `v030-20` | **Documentación y lanzamiento de la 0.3.0**<br>Nuevo `docs/usage-semantics.md`; el README cita la regla general "nunca mostrar una cifra desconocida como cero" como obligatoria para servidor y portal, y la regla 4 sigue para el componente; CHANGELOG con notas de cambios incompatibles; publicar npm, imagen GHCR y SDK de Python. | S | `v030-1`, `v030-14`, `v030-15`, `v030-17`, `v030-18`, `v030-19` |


## 0.4.0: Libro de consumo

### Objetivo

El servidor guarda una fila durable por cada llamada al modelo, con la hora de recepción del servidor, ids de correlación y atribución; responde preguntas agrupadas (agente, modelo, sesión, tarea, día, usuario, etiqueta); exporta CSV y JSONL que concilian exactamente; y lo hace con seguridad: los secretos se censuran antes de guardar o exportar nada, la retención es configurable y la API ya no puede quedar abierta por accidente.

### Criterios de salida

- "Cuánto gastó el agente X con el modelo Y esta semana" se responde con una sola llamada a `GET /api/v1/usage/rollup`, y el fixture dorado devuelve las cifras esperadas por moneda.
- Las exportaciones CSV y JSONL del fixture dorado concilian exactamente con la API de rollup por moneda, por `costSource` y por tipo de token; una exportación de 100 000 filas se transmite sin cargar todas las filas en memoria (crecimiento pico de RSS menor a 100 MB en la prueba).
- Un corpus de censura con al menos 30 formatos de secretos no filtra ningún secreto a los eventos guardados, los frames SSE, la API de llamadas ni las exportaciones.
- El servidor se niega a arrancar en una interfaz que no sea loopback sin token, salvo con `AGENT_VIEWER_ALLOW_OPEN=1`, y ningún endpoint acepta el token de la API en la query string.
- Recargar el portal muestra los mismos totales y estados de agentes que antes de recargar (e2e con Playwright).
- Para una sesión de Claude Code, el endpoint de conciliación reporta una desviación menor a 1% entre las filas del libro (logs) y las métricas de Claude Code.

### Elementos de trabajo

| ID | Elemento de trabajo | Esfuerzo | Depende de |
|---|---|---|---|
| `v040-1` | **Contrato: campos de correlación y atribución en los eventos de consumo**<br>`traceId`, `parentId`, `toolCallId`, `meetingId`, `userId` y `tags` opcionales (hasta 20 cadenas de hasta 64 caracteres) en `llm.usage` y `llm.failed`, con validación, documentación y pruebas de contrato; ambos SDK los aceptan. | M | `v030-3`, `v030-15` |
| `v040-2` | **Tabla del libro de consumo con hora de recepción del servidor**<br>Una migración agrega `usage_ledger`: una fila por cada `llm.usage` o `llm.failed` aceptado, con `received_at` del reloj del servidor, `occurred_at` del cliente, atribución, cada tipo de token anulable y estado. Relleno desde los eventos existentes; los duplicados nunca generan filas; `receivedAt` se expone en la API de eventos. | L | `v030-2`, `v030-8`, `v040-1` |
| `v040-3` | **API de consultas agrupadas (rollup)**<br>`GET /api/v1/usage/rollup?groupBy=agent\|model\|provider\|session\|task\|day\|user\|tag` con filtros devuelve el costo por moneda separado por `costSource`, conteos de costo desconocido, sumas de tokens por tipo con conteos de no reportados, y conteos de llamadas y fallos. Nunca suma monedas distintas ni costo reportado con estimado. | L | `v040-2` |
| `v040-4` | **API de llamadas con paginación por cursor**<br>`GET /api/v1/usage/calls` devuelve filas del libro (solo metadatos) con los mismos filtros que el rollup y paginación por cursor estable. Nunca devuelve texto de prompts ni de mensajes. | M | `v040-2` |
| `v040-5` | **Censura base de secretos**<br>Un censor en el servidor se ejecuta al ingerir sobre todo campo de texto libre antes de guardar, de SSE y de exportar, con patrones incluidos (claves de API de proveedores, tokens de GitHub, claves de AWS, bearer tokens, JWT, bloques de llave privada, cadenas de conexión) y patrones extra configurables; el consumo numérico nunca se toca; el ajuste "ocultar secretos" del portal queda conectado a todas las superficies de texto. | M | ninguno |
| `v040-6` | **Exportación CSV y JSONL**<br>`GET /api/v1/usage/export?format=csv\|jsonl` transmite las filas del libro con los filtros del rollup, columnas documentadas, solo texto censurado, protección contra inyección de fórmulas en CSV y totales por moneda para conciliar con la factura. El portal agrega una acción de exportar. | M | `v040-3`, `v040-5` |
| `v040-7` | **Retención base**<br>`AGENT_VIEWER_RETENTION_DAYS` purga eventos antiguos de forma programada; las filas del libro tienen su propio `AGENT_VIEWER_USAGE_RETENTION_DAYS` (por defecto: conservar). Las purgas se registran y se exponen en un endpoint de administración, y purgar eventos nunca cambia los rollups de las filas del libro retenidas. | M | `v040-2` |
| `v040-8` | **Cerrar las brechas de API abierta y token en la URL**<br>Negarse a enlazar una interfaz que no sea loopback sin token salvo permiso explícito; eliminar los parámetros `?token` y `?api_key`; los clientes EventSource usan tickets de un solo uso y corta vida desde `POST /api/v1/stream-tickets`; los logs de acceso nunca contienen tokens. | M | `v030-18` |
| `v040-9` | **El portal carga el historial completo al abrir**<br>Al abrir, el portal carga el snapshot, los rollups del libro y los eventos recientes (paginados) antes de suscribirse a SSE con el último id de evento, de modo que recargar nunca reinicia las cifras. Los paneles de consumo en vivo leen solo rollups del servidor. | M | `v040-3`, `v040-4`, `v030-11` |
| `v040-10` | **Ingesta de métricas OTLP y soporte http/protobuf**<br>`POST /v1/metrics` acepta las métricas de tokens y costo de Claude Code (temporalidad delta y acumulada) en una serie de telemetría aparte que nunca entra al libro ni a los totales; un endpoint de conciliación compara las sumas del libro y de las métricas por sesión y marca la desviación; logs y métricas también aceptan http/protobuf. | L | `v030-16`, `v040-2` |
| `v040-11` | **El parser de logs de eventos reconoce archivos OTLP de logs y métricas**<br>`parseEventLog` detecta `resourceLogs` y convierte los registros de Claude Code con el mapeador de v030-16; los archivos `resourceMetrics` devuelven un aviso claro de que las métricas no se pueden reproducir como llamadas; `resourceSpans` sigue diciendo "todavía no" hasta v070-2. | S | `v030-16` |
| `v040-12` | **Documentación y lanzamiento de la 0.4.0**<br>Referencia de la API del esquema del libro, rollup, llamadas, exportación, conciliación y tickets de stream; guía de censura y retención; notas de migración por el token de query eliminado; publicar npm, GHCR y SDK. | S | `v040-6`, `v040-7`, `v040-8`, `v040-9`, `v040-10`, `v040-11` |


## 0.5.0: Gasto visible en la oficina

### Objetivo

La oficina sigue siendo la vista protagonista y ahora muestra el gasto donde ocurre: una insignia por agente, el detalle de cada llamada al hacer clic, Model Ops alimentado solo con datos reales del libro, y costo por reunión y por herramienta. En la librería integrable cada cifra llega ya calculada desde la aplicación anfitriona mediante props; el componente nunca suma, pone precio ni compara.

### Criterios de salida

- Las insignias de consumo y el detalle de llamadas están ocultos por defecto en la librería y aparecen solo con las props de activación.
- Las pruebas de la librería demuestran que no hay aritmética: para cualquier cifra entregada por el anfitrión, la insignia y el detalle muestran exactamente esos valores, y null se muestra como "desconocido".
- El detalle por llamada no muestra texto de prompts, mensajes ni argumentos de herramientas, verificado con eventos que traen ese texto.
- Las pestañas de Model Ops con datos reales no contienen ninguna entrada simulada; la pestaña del simulador es el único lugar donde aparecen llamadas simuladas, y cada una está rotulada SIMULADO.
- Los totales de costo por reunión y por herramienta concilian exactamente con los rollups del libro para el fixture dorado.

### Elementos de trabajo

| ID | Elemento de trabajo | Esfuerzo | Depende de |
|---|---|---|---|
| `v050-1` | **Librería: insignias de consumo por agente desde props del anfitrión**<br>Nueva prop de activación `showUsageBadges`; el contenido de la insignia viene de las cifras `usage.byAgent` que entrega el anfitrión (solo para mostrar); el canvas dibuja una insignia compacta por escritorio con texto accesible; lo desconocido se muestra como "desconocido". | M | `v030-13` |
| `v050-2` | **Librería: panel de detalle por llamada desde props del anfitrión**<br>Nuevas props `agentCallDetails` y `onAgentSelect`: al hacer clic en un agente se abre un panel con solo modelo, proveedor, tokens por tipo, `requestId`, latencia, estado y `costSource`. El componente nunca consulta, suma ni deriva cifras, y el tipo excluye campos de texto. | M | `v050-1` |
| `v050-3` | **Portal: insignias y detalle de llamadas respaldados por el libro**<br>El portal actúa como anfitrión: llena las insignias desde la API de rollup y el panel de detalle desde la API de llamadas con paginación, se actualiza con los eventos de consumo por SSE y respeta el ajuste de censura. | M | `v050-2`, `v040-3`, `v040-4` |
| `v050-4` | **Model Ops con datos reales del libro**<br>Las pestañas de matriz, agentes y feed leen rollups y llamadas del servidor (por modelo por llamada, fallos, caché leída y escrita), en lugar de la agregación a nivel de agente y el feed inventado; la pestaña del simulador queda aislada y rotulada; los estados vacíos explican cómo enviar consumo real. | L | `v040-3`, `v040-4`, `v030-14` |
| `v050-5` | **Costo por reunión y por herramienta en el servidor**<br>Rollup con `groupBy` reunión y herramienta usando `meetingId` y `toolCallId`, con el nombre de la herramienta resuelto desde los eventos `tool.started`; las llamadas sin vínculo se reportan como sin atribuir, nunca se adivinan por coincidencia de tiempo. | M | `v040-3` |
| `v050-6` | **Portal: gasto por reunión y por herramienta en la oficina**<br>El panel de reunión y los tooltips de herramientas muestran el costo y los tokens calculados por el servidor por reunión y por herramienta, con conteos de sin atribuir; la librería recibe props opcionales del anfitrión para las mismas cifras, solo para mostrar. | M | `v050-5`, `v050-1` |
| `v050-7` | **Documentación y lanzamiento de la 0.5.0**<br>Guía de la librería (`docs/library.md` y `docs/library.es.md`) para insignias, detalle de llamadas y reglas de privacidad, con un anfitrión de ejemplo que lee la API de rollup; publicar. | S | `v050-3`, `v050-4`, `v050-6` |


## 0.6.0: Precios y control

### Objetivo

El servidor estima el costo a partir de una tabla de precios versionada que cubre cada tipo de token facturado, nunca inventa un precio y nunca mezcla estimaciones con costo reportado; los presupuestos generan alertas y ponen los escritorios en ámbar o rojo; los percentiles de latencia y las tasas de error por modelo salen solo de datos reales.

### Criterios de salida

- La tabla de precios admite precios de entrada, salida, lectura de caché, escritura de caché y razonamiento por modelo, con fechas de vigencia y sobrescrituras por modelo; un modelo sin precio recibe una estimación nula (probado).
- Toda fila estimada del libro lleva `costSource` "estimated" y su `pricingVersion`; cambiar precios nunca reescribe las filas existentes, salvo que un recálculo explícito cree una nueva versión de precios.
- Ninguna respuesta de la API ni exportación suma costo reportado y estimado en un solo número (una prueba de contrato en cada endpoint de consumo).
- Un cruce de presupuesto genera una alerta (evento y webhook saliente) en menos de 5 segundos desde la llamada que lo provoca.
- En la librería, los colores de presupuesto de los escritorios vienen solo de la prop del anfitrión (una prueba con una prop que contradice las cifras de consumo muestra el estado de la prop).
- Los p50 y p95 de latencia por modelo se calculan solo con filas que tienen `latencyMs` y siempre se muestran con el tamaño de la muestra.

### Elementos de trabajo

| ID | Elemento de trabajo | Esfuerzo | Depende de |
|---|---|---|---|
| `v060-1` | **Tabla de precios versionada en el servidor**<br>Precios guardados en el servidor (archivo más API de administración) por proveedor y modelo: entrada, salida, lectura de caché, escritura de caché y razonamiento por millón de tokens, moneda y `effectiveFrom`; cada cambio crea una nueva `pricingVersion`; sobrescrituras por modelo; sin precio por defecto ni de respaldo; incluye una tabla inicial marcada como estimada con la fecha de su fuente. | M | `v040-2` |
| `v060-2` | **Costo estimado por fila del libro**<br>Cada fila recibe `estimatedCost`, `estimatedCurrency` y `pricingVersion`, calculados al ingerir con la tabla vigente en `occurred_at` y separados del costo reportado; rollups y exportaciones devuelven ambos lado a lado; un endpoint de recálculo explícito escribe bajo una nueva versión. | M | `v060-1`, `v040-3`, `v040-6` |
| `v060-3` | **Motor de presupuestos**<br>Presupuestos por agente, modelo, sesión, usuario o etiqueta con periodo, moneda, base (solo reportado, o reportado más estimado, rotulado) y umbrales de advertencia y límite; el servidor calcula el estado (ok, advertencia, excedido, desconocido cuando el costo es desconocido) y lo expone en el snapshot y en `GET /api/v1/budgets`. | M | `v060-2` |
| `v060-4` | **Entrega de alertas de presupuesto**<br>Los cruces de umbral emiten un evento del servidor y un webhook saliente firmado opcional con reintentos; las alertas se deduplican por presupuesto y periodo. | S | `v060-3` |
| `v060-5` | **Librería: estado de presupuesto mediante props del anfitrión**<br>Nueva prop `budgetStateByAgent` (ok, advertencia, excedido, desconocido, más una etiqueta opcional); los escritorios se pintan en ámbar o rojo con una alternativa de texto, no solo por color; el componente nunca compara el gasto con un límite; oculto salvo que se active. | S | `v050-1` |
| `v060-6` | **Portal: interfaz de precios y presupuestos**<br>La pestaña de precios en Model Ops y el editor de precios de los ajustes leen y escriben la tabla del servidor en lugar del estado local; interfaz de gestión de presupuestos; escritorios coloreados con el estado de presupuesto del servidor mediante la prop de la librería. | M | `v060-2`, `v060-3`, `v060-5` |
| `v060-7` | **Percentiles de latencia y tasas de error por modelo**<br>Los rollups agregan latencia p50 y p95 calculada solo con `latencyMs` real (las filas sin ella se excluyen y se cuentan), tasa de fallos por tipo de error desde `llm.failed` y conteos de límites de tasa, mostrados en Model Ops con el tamaño de la muestra. | M | `v040-3` |
| `v060-8` | **Documentación y lanzamiento de la 0.6.0**<br>Guía de precios (cómo funcionan las estimaciones y qué nunca se asume), guía de presupuestos y alertas, documentación de la firma de webhooks; publicar. | S | `v060-4`, `v060-6`, `v060-7` |


## 0.7.0: Captura automática e interoperabilidad

### Objetivo

El consumo llega sin instrumentación escrita a mano: trazas OTLP con las convenciones GenAI, adaptadores empaquetados de LangGraph y OpenAI Agents, colas en los SDK que sobreviven a caídas del servidor, y una exportación `/metrics` para que las pilas de monitoreo existentes lean tokens y costo.

### Criterios de salida

- Fixtures grabados de trazas OTLP de al menos dos instrumentaciones GenAI se convierten en filas del libro con los tipos de token correctos y sin costo inventado.
- Los adaptadores de LangGraph y OpenAI Agents son paquetes instalables y capturan los tokens de cada llamada al modelo en sus ejecuciones de ejemplo (el número de llamadas es igual al de respuestas del proveedor).
- Con el servidor caído 10 minutos, ambos SDK entregan después todos los eventos en cola con cero duplicados en el libro.
- `GET /metrics` pasa `promtool check metrics` y sus contadores coinciden con los rollups del fixture dorado.

### Elementos de trabajo

| ID | Elemento de trabajo | Esfuerzo | Depende de |
|---|---|---|---|
| `v070-1` | **Receptor de trazas OTLP con convenciones semánticas GenAI**<br>`POST /v1/traces` (http/json y http/protobuf) convierte los spans `gen_ai` en `llm.usage` o `llm.failed` (tokens, atributos de caché si existen, modelo, latencia a partir de la duración del span) conservando `traceId` y `parentId`, y los spans de herramientas en eventos de herramienta; ids deterministas; sin costo salvo que el span lo reporte. | L | `v040-1`, `v040-10` |
| `v070-2` | **Parser de logs de eventos: importar trazas OTLP**<br>`parseEventLog` convierte archivos `resourceSpans` con el mapeador de v070-1 en vez de decir "todavía no"; actualizar la sección "What it is not" del README. | S | `v070-1`, `v040-11` |
| `v070-3` | **Adaptador de LangGraph empaquetado**<br>Convertir el ejemplo de LangGraph en un paquete publicado que captura el consumo de nodos, herramientas y modelos con `requestId`, tokens de caché e ids de traza desde los callbacks; pruebas con ejecuciones grabadas. | L | `v040-1` |
| `v070-4` | **Adaptador de OpenAI Agents empaquetado**<br>Convertir el ejemplo de OpenAI Agents en un paquete publicado que usa el procesador de trazas del SDK para emitir agentes, herramientas, `llm.usage` y `llm.failed`; pruebas con ejecuciones grabadas. | L | `v040-1` |
| `v070-5` | **Cola local durable en el SDK de Python**<br>Cola opcional en disco, con tope, para los eventos que fallan tras los reintentos, reenviados en orden con sus ids originales cuando el servidor vuelve; tope de tamaño con contadores explícitos de descartes; pruebas con el servidor caído. | M | `v030-15` |
| `v070-6` | **Cola local durable en el SDK de TypeScript**<br>El mismo comportamiento que v070-5 para Node (archivo en disco) y una cola acotada en memoria para navegadores; escenarios de prueba compartidos. | M | `v030-15` |
| `v070-7` | **Exportación `/metrics` para Prometheus**<br>`GET /metrics` opcional y protegido con autenticación, con contadores de tokens por tipo, costo reportado y estimado por moneda (nunca sumado entre monedas), llamadas y fallos por modelo y tipo de error, conteos de ingesta y duplicados e histogramas de latencia; envío opcional de métricas por OTLP. | M | `v040-3`, `v060-2` |
| `v070-8` | **Documentación y lanzamiento de la 0.7.0**<br>Actualizar la tabla de madurez (adaptadores empaquetados frente a ejemplos), guías de configuración de OTLP, configuración de las colas de los SDK y un ejemplo de scrape de Prometheus; publicar los paquetes. | S | `v070-2`, `v070-3`, `v070-4`, `v070-5`, `v070-6`, `v070-7` |


## 0.8.0: Auditoría formal

### Objetivo

El historial pasa a ser a prueba de manipulación y atribuible: una cadena de hashes verificable sobre cada evento guardado, claves de ingesta con nombre registradas en cada evento, acceso de auditor de solo lectura, retención y censura que mantienen la cadena verificable, y un paquete de auditoría verificable sin conexión.

### Criterios de salida

- Cambiar, borrar o reordenar cualquier evento o fila del libro guardados es detectado por `agent-viewer verify` y por la API de verificación (pruebas de mutación).
- Cada evento y fila del libro registra el id de la clave que lo envió.
- Las claves de auditor reciben 403 en todo endpoint de escritura y tienen lectura completa del libro, los rollups y las exportaciones.
- Tras una purga por retención la cadena sigue verificándose mediante lápidas (tombstones).
- Un paquete de auditoría exportado se verifica sin conexión en una máquina sin el servidor.

### Elementos de trabajo

| ID | Elemento de trabajo | Esfuerzo | Depende de |
|---|---|---|---|
| `v080-1` | **Cadena de hashes sobre los eventos guardados**<br>Una migración agrega `prev_hash` y `hash` (sobre el JSON canónico, `received_at` y el id de quien envía) calculados en la transacción de inserción; los datos existentes parten de un checkpoint génesis registrado; el modo memoria documenta que no es a prueba de manipulación. | L | `v030-2`, `v040-2` |
| `v080-2` | **Verificación de la cadena y checkpoints firmados**<br>Un comando `agent-viewer verify` y `GET /api/v1/audit/verify` reportan el primer eslabón roto; checkpoints periódicos firmados con una clave del servidor y exportables. | M | `v080-1` |
| `v080-3` | **Claves de ingesta con nombre e identidad de quien envía**<br>Varias claves de API con nombre (guardadas con hash) reemplazan el token compartido único; cada evento y fila del libro aceptados registra el id de la clave que los envió; CLI y API de gestión de claves. | M | `v040-8` |
| `v080-4` | **Claves con alcance: rol de auditor de solo lectura**<br>Alcances de clave `ingest`, `read`, `audit` y `admin`; las claves de auditor pueden leer el libro, los rollups, las exportaciones y la verificación, pero nunca escribir ni cambiar precios, presupuestos o retención. | M | `v080-3` |
| `v080-5` | **Retención y censura compatibles con la cadena**<br>Las purgas por retención y las censuras posteriores reemplazan los payloads por lápidas que conservan el hash original para que la cadena se verifique; la versión de la regla de censura se registra por fila; las acciones de purga y censura son a su vez eventos de auditoría encadenados; una marca de retención legal detiene las purgas. | M | `v080-1`, `v040-5`, `v040-7` |
| `v080-6` | **Paquete de auditoría verificable sin conexión**<br>Exportación de filas del libro, eventos, hashes de la cadena, checkpoints y las versiones de precios usadas, más un script verificador independiente; formato documentado. | M | `v080-2`, `v080-5` |
| `v080-7` | **Documentación, modelo de amenazas y lanzamiento de la 0.8.0**<br>Guía de auditoría, gestión de claves, modelo de amenazas (qué demuestra la cadena y qué no, límites del modo memoria) y notas de migración desde el token único; publicar. | S | `v080-4`, `v080-6` |

## Fuera de alcance

Son decisiones deliberadas, no trabajo pospuesto:

- **Precios o aritmética dentro de la librería integrable.** Los precios viven en el servidor. El componente solo muestra las cifras que le entrega su anfitrión.
- **Convertir monedas, o tomar prestado el precio de otro modelo** cuando falta un precio. Un precio ausente es una estimación desconocida.
- **Mezclar costo estimado y costo facturado** en un solo número.
- **Evaluaciones y datasets.** Agent Viewer observa el consumo; no califica resultados.
- **Convertirse en un proxy** entre el agente y el proveedor de IA. El consumo lo reporta el runtime o se captura de la telemetría; el tráfico nunca pasa por Agent Viewer.
- **Reemplazar la oficina por un tablero genérico de gráficas.** La oficina sigue siendo la vista protagonista y el gasto se muestra en ella.
- **Registrar el razonamiento privado del modelo, prompts o texto de mensajes** en el libro de consumo.

## Cómo contribuir

1. Elige un elemento de trabajo por su id (por ejemplo `v030-13`). Los elementos sin dependencias, o cuyas dependencias ya están integradas, pueden empezar ya. Los elementos pequeños (S) son una buena primera contribución.
2. Abre o toma el issue correspondiente antes de escribir código y di en él qué elemento tomas. Si el issue aún no existe, [abre uno](https://github.com/jmmana/Agent-Viewer/issues/new) que cite el id del elemento.
3. Sigue [CONTRIBUTING.md](../.github/CONTRIBUTING.md) y el [código de conducta](../.github/CODE_OF_CONDUCT.md) (ambos en inglés), y corre las mismas verificaciones que CI antes de abrir el pull request.
4. Respeta los [principios](#principios). A un pull request que convierta un desconocido en cero, mezcle monedas o agregue aritmética a la librería se le pedirán cambios.
5. Las pruebas son parte del elemento. Varios elementos agregan casos a la suite dorada de conciliación (`v030-19`); agrega los tuyos ahí.

¿No estás de acuerdo con el orden, el alcance de un elemento o los criterios de salida de una versión? Dilo en un issue. La hoja de ruta es un documento vivo y los cambios entran mediante pull requests a este archivo.
