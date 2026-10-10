/**
 * Demo app texts (not the library) for this area, in English and Spanish.
 * The keys are merged into the app catalog in `src/i18n.ts`. Placeholders use `{name}` and are filled by
 * `t(locale, key, params)`.
 */

const EN = {
  // Header
  'ops.title': 'Model Ops & Token Operations Center',
  'ops.header.activeNodes': '{count} active nodes',
  'ops.subtitle': 'Live, interactive token, inference and cost usage by provider and model',
  'ops.close.aria': 'Close Model Ops (Esc)',

  // Summary strip
  'ops.stats.totalTokens': 'Total tokens',
  'ops.stats.estimatedSpend': 'Estimated spend',
  'ops.stats.inputOutput': 'Input / output',
  'ops.stats.inputTitle': 'Input tokens',
  'ops.stats.outputTitle': 'Output tokens',
  'ops.stats.cacheReasoning': 'Cache / reasoning',
  'ops.stats.cachedTitle': 'Cached tokens',
  'ops.stats.reasoningTitle': 'Chain-of-thought reasoning tokens',
  'ops.stats.providersModels': 'Providers / models',
  'ops.stats.providersCount': 'providers ({models} models)',
  'ops.unit.usd': 'USD',
  'ops.tokens.inValue': '{value} in',
  'ops.tokens.outValue': '{value} out',

  // Tabs and global actions
  'ops.tabs.label': 'Model Ops sections',
  'ops.tab.matrix': 'Usage by provider and model',
  'ops.tab.simulator': 'LLM traffic simulator',
  'ops.tab.agents': 'Agent assignment ({count})',
  'ops.tab.feed': 'Inference feed',
  'ops.quickBurst': 'Inject quick request (+1.9K t)',

  // Last simulated call notification
  'ops.toast.burst': 'Simulated call on {provider} · {model}: +{tokens} tokens (estimated {cost})',

  // Matrix tab: filters
  'ops.filter.provider': 'Provider:',
  'ops.filter.providerGroup': 'Filter by provider',
  'ops.filter.all': 'All ({count})',
  'ops.search.placeholder': 'Search model or provider...',
  'ops.search.label': 'Search model or provider',
  'ops.sort.label': 'Sort:',
  'ops.sort.tokens': 'Tokens',
  'ops.sort.cost': 'Cost ($)',
  'ops.sort.output': 'Output',

  // Matrix tab: provider cards
  'ops.providers.heading': 'Aggregated usage by provider',
  'ops.providers.monitored': '{count} providers monitored',
  'ops.provider.desc.openai': 'GPT-4o, GPT-4 Turbo, o1 reasoning engine',
  'ops.provider.desc.anthropic': 'Claude 3.5 Sonnet, Claude 3 Opus, Haiku',
  'ops.provider.desc.gemini': 'Gemini 2.5 Pro, Gemini 2.5 Flash, multimodal 2M context',
  'ops.provider.desc.ollama': 'Local on-premise execution (Llama 3.3, DeepSeek R1)',
  'ops.provider.desc.external': 'External LLM provider endpoint',
  'ops.provider.modelsCount': '{count} models',
  'ops.provider.share': 'Office share:',
  'ops.provider.activeAgents': '{count} active',
  'ops.provider.showAll': 'Show all',
  'ops.provider.filter': 'Filter',
  'ops.provider.quickBurst': 'Quick request',
  'ops.provider.quickBurstTitle': 'Inject a quick request into {model}',
  'ops.metric.totalTokens': 'TOTAL TOKENS',
  'ops.metric.costUsd': 'COST USD',
  'ops.metric.inOut': 'IN / OUT',
  'ops.metric.agents': 'AGENTS',

  // Matrix tab: model rows
  'ops.models.heading': 'Detailed usage matrix by model',
  'ops.models.subtitle': 'Side-by-side comparison of token usage, input/output, cache and inference rates',
  'ops.models.showing': 'Showing {count} model(s)',
  'ops.models.empty': 'No models match the current filter.',
  'ops.models.context': 'Context: {value}',
  'ops.models.latency': 'Latency: ~{ms}ms',
  'ops.models.configure': 'Configure simulation',
  'ops.models.simulate': 'Simulate inference',
  'ops.models.relativeVolume': 'Relative office volume:',
  'ops.models.volumeValue': '{tokens} tokens ({share}%)',
  'ops.models.assignedAgents': 'Assigned agents ({count}):',
  'ops.models.focusAgentTitle': 'Center the camera on {name} in the office',
  'ops.models.noAgents': 'Available in the cluster with no agents assigned right now',
  'ops.metric.input': 'INPUT (PROMPT)',
  'ops.metric.output': 'OUTPUT (COMPLETION)',
  'ops.metric.cache': 'CONTEXT CACHE',
  'ops.metric.reasoning': 'REASONING (COT)',
  'ops.metric.reasoningHint': 'thinking',
  'ops.metric.estimatedCost': 'ESTIMATED COST',
  'ops.models.notInCatalog': 'Not in the demo catalog',
  'ops.value.unknown': 'Unknown',
  'ops.model.desc.gpt-4o': 'Flagship multimodal model with high speed and precision',
  'ops.model.desc.o1-mini': 'Advanced chain-of-thought reasoning for logic and math',
  'ops.model.desc.gpt-4o-mini': 'Ultra-fast, cost-effective inference for high throughput',
  'ops.model.desc.claude-3-5-sonnet': 'Premier coding, architectural reasoning and artifact generation',
  'ops.model.desc.claude-3-5-haiku': 'Sub-second response time for triage, QA and test generation',
  'ops.model.desc.gemini-2.5-pro': 'Massive 2M context window with native multimodal and code synthesis',
  'ops.model.desc.gemini-2.5-flash': 'Breakthrough speed with a million-token context at a fraction of the cost',
  'ops.model.desc.llama-3.3-70b': 'Zero-cloud, air-gapped local execution on on-premise hardware',
  'ops.model.desc.deepseek-r1-distill': 'Open-weights reasoning engine executed locally without cloud egress',

  // Simulator tab
  'ops.sim.heading': 'LLM inference and load simulation console',
  'ops.sim.intro':
    'Generate synthetic real-time requests to any AI model in the cluster. Watch the telemetry update instantly, the server racks blink in the Model Ops room, and costs and cache shares get calculated.',
  'ops.sim.presets': '1. Preset load:',
  'ops.sim.preset.chat': 'Quick query',
  'ops.sim.preset.code': 'Code generation',
  'ops.sim.preset.rag': 'Document RAG analysis',
  'ops.sim.preset.batch': 'Bulk processing',
  'ops.sim.presetSplit': '{input} in / {output} out',
  'ops.sim.presetTotal': '~{tokens} tokens',
  'ops.sim.presetTotalCache': '~{tokens} tokens ({ratio}% cache)',
  'ops.sim.targetModel': 'Target LLM model:',
  'ops.sim.rate': 'Rate: ${input}/1M in · ${output}/1M out',
  'ops.sim.inputTokens': 'Input tokens (prompt):',
  'ops.sim.outputTokens': 'Output tokens (completion):',
  'ops.sim.summary': 'Injection summary:',
  'ops.sim.totalTokens': '{value} total tokens',
  'ops.sim.cachedValue': '{value} cached',
  'ops.sim.costValue': '${value} USD',
  'ops.sim.fire': 'Fire live inference',
  'ops.sim.banner': 'Simulation. These calls are not sent to any model and are not counted in any total.',
  'ops.sim.rateUnknown': 'Rate: unknown',
  'ops.sim.estimatedLabel': 'Demo catalog rate (estimate)',

  // Agents tab
  'ops.agents.heading': 'Interactive model reassignment for agents',
  'ops.agents.subtitle':
    "Change each agent's assigned model or provider in real time. Its future inferences will be counted on the matching node.",
  'ops.agents.col.agent': 'AGENT',
  'ops.agents.col.role': 'ROLE',
  'ops.agents.col.provider': 'CURRENT PROVIDER',
  'ops.agents.col.model': 'ASSIGNED MODEL',
  'ops.agents.col.tokens': 'ACCUMULATED TOKENS',
  'ops.agents.col.action': 'ACTION',
  'ops.agents.modelSelect': 'Assigned model for {name}',
  'ops.agents.focus': 'Center camera',
  'ops.agents.focusAria': 'Center camera on {name}',
  'ops.agents.readOnlyLive': 'The portal cannot change the model of a remote agent.',

  // Feed tab
  'ops.feed.simulated.heading': 'Simulated calls',
  'ops.feed.simulated.empty': 'Run the simulator to see example calls here.',
  'ops.feed.emit': 'Send request',
  'ops.feed.by': 'by',
  'ops.feed.operator': 'Simulator operator',
  'ops.feed.col.tokens': 'TOKENS',
  'ops.feed.col.latency': 'LATENCY',
  'ops.feed.col.cost': 'COST',

  // Simulated badge, shown on every simulated item: feed row, simulator summary, toast, agent bubble
  'ops.badge.simulated': 'SIMULATED',

  // Footer
  'ops.footer.tip': 'Tip:',
  'ops.footer.tipText':
    'Click the server racks or the NOC screen in the Model Ops room of the office to open this panel.',
  'ops.footer.close': 'Close',

  // Data source mode (issue #79): ledger vs simulated demo data
  'ops.mode.ledgerStatus': 'Ledger, as of {time}',
  'ops.mode.simulatedBadge': 'Simulated',
  'ops.banner.simulatedData':
    'Simulated demo data. These figures come from the local demo state, not the usage ledger.',

  // Ledger-mode stats strip
  'ops.stats.reportedCost': 'Reported cost',
  'ops.stats.calls': 'Calls',
  'ops.stats.failedCalls': 'Failed calls',

  // Unknown / partial / multi-currency rendering, shared by Matrix, Agents and Feed
  'ops.value.na': 'n/a',
  'ops.value.partial': 'partial',
  'ops.value.partialTitle': '{unreported} of {total} calls did not report this',
  'ops.cost.unknownCalls': '{count} calls without cost',
  'ops.cost.source.estimated': 'estimated',
  'ops.cost.source.unknown': 'unknown source',
  'ops.sort.costDisabledTitle': 'Cost sort is unavailable: the displayed rows mix currencies or cost sources.',

  // Matrix tab, ledger mode
  'ops.matrix.timeRange.label': 'Time range:',
  'ops.matrix.timeRange.all': 'All time',
  'ops.matrix.timeRange.last24h': 'Last 24 hours',
  'ops.matrix.timeRange.last7d': 'Last 7 days',
  'ops.matrix.truncated': 'Showing the top {count} groups by tokens.',
  'ops.matrix.col.calls': 'CALLS',
  'ops.matrix.col.failedCalls': 'FAILED',
  'ops.matrix.col.input': 'INPUT',
  'ops.matrix.col.output': 'OUTPUT',
  'ops.matrix.col.cacheRead': 'CACHE READ',
  'ops.matrix.col.cacheWrite': 'CACHE WRITE',
  'ops.matrix.col.reasoning': 'REASONING',
  'ops.matrix.col.cost': 'COST',

  // Agents tab, ledger mode
  'ops.agents.ledger.heading': 'Usage by agent and model',
  'ops.agents.ledger.subtitle': 'From the usage ledger: one row per agent and model actually called.',
  'ops.agents.col.calls': 'CALLS',
  'ops.agents.col.failedCalls': 'FAILED',
  'ops.agents.col.cost': 'COST',
  'ops.agents.noUsage': 'No usage reported',
  'ops.agents.unattributed': 'Unattributed',

  // Feed tab, ledger mode
  'ops.feed.ledger.heading': 'Recent model calls',
  'ops.feed.ledger.loadMore': 'Load more',
  'ops.feed.ledger.loading': 'Loading more...',
  'ops.feed.ledger.col.time': 'TIME',
  'ops.feed.ledger.col.model': 'MODEL',
  'ops.feed.ledger.col.agent': 'AGENT',
  'ops.feed.ledger.col.status': 'STATUS',
  'ops.feed.ledger.col.tokens': 'TOKENS',
  'ops.feed.ledger.col.latency': 'LATENCY',
  'ops.feed.ledger.col.cost': 'COST',
  'ops.feed.ledger.costUnknown': 'Cost not reported',
  'ops.feed.ledger.filter.status': 'Status:',
  'ops.feed.ledger.filter.statusAll': 'All',
  'ops.feed.ledger.filter.statusFailed': 'Failed',
  'ops.feed.ledger.filter.model': 'Model:',
  'ops.feed.ledger.filter.agent': 'Agent:',
  'ops.feed.ledger.filter.allModels': 'All models',
  'ops.feed.ledger.filter.allAgents': 'All agents',
  'ops.feed.ledger.unattributed': 'Unattributed',
  'ops.feed.ledger.detailTitle': 'event {eventId} / session {sessionId}',

  // Empty and error states, shared by Matrix, Agents and Feed in ledger mode
  'ops.empty.loading': 'Loading usage data...',
  'ops.empty.unavailable': 'This server does not expose the usage ledger. Upgrade the Agent Viewer server to 0.4.0 or later.',
  'ops.empty.unauthorized': 'The server requires an API token. Configure it for the portal.',
  'ops.empty.networkError': 'Could not reach the server.',
  'ops.empty.retry': 'Retry',
  'ops.empty.noCalls.heading': 'No model calls have been recorded yet',
  'ops.empty.noCalls.intro': 'Send a real llm.usage event and it will show up here.',
  'ops.empty.noCalls.curlHeading': 'From the command line:',
  'ops.empty.noCalls.pythonHeading': 'From the Python SDK:',
  'ops.empty.noCalls.typescriptHeading': 'From the TypeScript SDK:',
  'ops.empty.noCalls.docsLink': 'Read the integration guide',
  'ops.empty.noCalls.naNote': 'Fields you leave out show as "n/a", never as zero.',
  'ops.empty.filtered': 'No calls match the current filters.',
  'ops.empty.clearFilters': 'Clear filters',
} as const satisfies Record<string, string>;

const ES: Record<keyof typeof EN, string> = {
  // Header
  'ops.title': 'Model Ops y Centro de Operaciones de Tokens',
  'ops.header.activeNodes': '{count} nodos activos',
  'ops.subtitle': 'Consumo interactivo en tiempo real de tokens, inferencias y costos por proveedor y modelo',
  'ops.close.aria': 'Cerrar Model Ops (Esc)',

  // Summary strip
  'ops.stats.totalTokens': 'Tokens totales',
  'ops.stats.estimatedSpend': 'Gasto estimado',
  'ops.stats.inputOutput': 'Entrada / salida',
  'ops.stats.inputTitle': 'Tokens de entrada',
  'ops.stats.outputTitle': 'Tokens de salida',
  'ops.stats.cacheReasoning': 'Caché / razonamiento',
  'ops.stats.cachedTitle': 'Tokens en caché',
  'ops.stats.reasoningTitle': 'Tokens de razonamiento en cadena (CoT)',
  'ops.stats.providersModels': 'Proveedores / modelos',
  'ops.stats.providersCount': 'proveedores ({models} modelos)',
  'ops.unit.usd': 'USD',
  'ops.tokens.inValue': '{value} entrada',
  'ops.tokens.outValue': '{value} salida',

  // Tabs and global actions
  'ops.tabs.label': 'Secciones de Model Ops',
  'ops.tab.matrix': 'Consumo por proveedor y modelo',
  'ops.tab.simulator': 'Simulador de tráfico LLM',
  'ops.tab.agents': 'Asignación a agentes ({count})',
  'ops.tab.feed': 'Flujo de inferencia',
  'ops.quickBurst': 'Inyectar petición rápida (+1.9K t)',

  // Última llamada simulada
  'ops.toast.burst': 'Llamada simulada en {provider} · {model}: +{tokens} tokens (estimado {cost})',

  // Matrix tab: filters
  'ops.filter.provider': 'Proveedor:',
  'ops.filter.providerGroup': 'Filtrar por proveedor',
  'ops.filter.all': 'Todos ({count})',
  'ops.search.placeholder': 'Buscar modelo o proveedor...',
  'ops.search.label': 'Buscar modelo o proveedor',
  'ops.sort.label': 'Ordenar:',
  'ops.sort.tokens': 'Tokens',
  'ops.sort.cost': 'Costo ($)',
  'ops.sort.output': 'Salida',

  // Matrix tab: provider cards
  'ops.providers.heading': 'Consumo agregado por proveedor',
  'ops.providers.monitored': '{count} proveedores monitorizados',
  'ops.provider.desc.openai': 'GPT-4o, GPT-4 Turbo, motor de razonamiento o1',
  'ops.provider.desc.anthropic': 'Claude 3.5 Sonnet, Claude 3 Opus, Haiku',
  'ops.provider.desc.gemini': 'Gemini 2.5 Pro, Gemini 2.5 Flash, multimodal con contexto de 2M',
  'ops.provider.desc.ollama': 'Ejecución local en infraestructura propia (Llama 3.3, DeepSeek R1)',
  'ops.provider.desc.external': 'Endpoint de proveedor LLM externo',
  'ops.provider.modelsCount': '{count} modelos',
  'ops.provider.share': 'Cuota de la oficina:',
  'ops.provider.activeAgents': '{count} activos',
  'ops.provider.showAll': 'Ver todos',
  'ops.provider.filter': 'Filtrar',
  'ops.provider.quickBurst': 'Petición rápida',
  'ops.provider.quickBurstTitle': 'Inyectar una petición rápida en {model}',
  'ops.metric.totalTokens': 'TOKENS TOTALES',
  'ops.metric.costUsd': 'COSTO USD',
  'ops.metric.inOut': 'ENTRADA / SALIDA',
  'ops.metric.agents': 'AGENTES',

  // Matrix tab: model rows
  'ops.models.heading': 'Matriz detallada de consumo por modelo',
  'ops.models.subtitle':
    'Comparativa de consumo de tokens, entradas y salidas, caché y tarifas de inferencia',
  'ops.models.showing': 'Mostrando {count} modelo(s)',
  'ops.models.empty': 'Ningún modelo coincide con el filtro actual.',
  'ops.models.context': 'Contexto: {value}',
  'ops.models.latency': 'Latencia: ~{ms}ms',
  'ops.models.configure': 'Configurar simulación',
  'ops.models.simulate': 'Simular inferencia',
  'ops.models.relativeVolume': 'Volumen relativo en la oficina:',
  'ops.models.volumeValue': '{tokens} tokens ({share}%)',
  'ops.models.assignedAgents': 'Agentes asignados ({count}):',
  'ops.models.focusAgentTitle': 'Centrar la cámara en {name} dentro de la oficina',
  'ops.models.noAgents': 'Disponible en el clúster, sin agentes asignados en este momento',
  'ops.metric.input': 'ENTRADA (PROMPT)',
  'ops.metric.output': 'SALIDA (COMPLETION)',
  'ops.metric.cache': 'CACHÉ DE CONTEXTO',
  'ops.metric.reasoning': 'RAZONAMIENTO (COT)',
  'ops.metric.reasoningHint': 'pensamiento',
  'ops.metric.estimatedCost': 'COSTO ESTIMADO',
  'ops.models.notInCatalog': 'No está en el catálogo de demostración',
  'ops.value.unknown': 'Desconocido',
  'ops.model.desc.gpt-4o': 'Modelo multimodal insignia, rápido y preciso',
  'ops.model.desc.o1-mini': 'Razonamiento avanzado en cadena (CoT) para lógica y matemáticas',
  'ops.model.desc.gpt-4o-mini': 'Inferencia ultrarrápida y económica para alto volumen',
  'ops.model.desc.claude-3-5-sonnet': 'Referente en programación, razonamiento de arquitectura y generación de artefactos',
  'ops.model.desc.claude-3-5-haiku': 'Respuesta en menos de un segundo para triaje, QA y generación de pruebas',
  'ops.model.desc.gemini-2.5-pro': 'Enorme ventana de contexto de 2M, multimodal nativo y síntesis de código',
  'ops.model.desc.gemini-2.5-flash': 'Velocidad excepcional con contexto de un millón de tokens a una fracción del costo',
  'ops.model.desc.llama-3.3-70b': 'Ejecución local aislada, sin nube, en hardware propio',
  'ops.model.desc.deepseek-r1-distill': 'Motor de razonamiento de pesos abiertos ejecutado localmente, sin salida a la nube',

  // Simulator tab
  'ops.sim.heading': 'Consola de simulación de inferencia y carga LLM',
  'ops.sim.intro':
    'Genera peticiones sintéticas en tiempo real a cualquiera de los modelos de IA del clúster. Verás cómo se actualiza la telemetría al instante, cómo parpadean los racks de servidores en la sala Model Ops y cómo se calculan los costos y las cuotas de caché.',
  'ops.sim.presets': '1. Carga predefinida:',
  'ops.sim.preset.chat': 'Consulta rápida',
  'ops.sim.preset.code': 'Generación de código',
  'ops.sim.preset.rag': 'Análisis RAG de documentos',
  'ops.sim.preset.batch': 'Procesamiento masivo',
  'ops.sim.presetSplit': '{input} entrada / {output} salida',
  'ops.sim.presetTotal': '~{tokens} tokens',
  'ops.sim.presetTotalCache': '~{tokens} tokens ({ratio}% caché)',
  'ops.sim.targetModel': 'Modelo LLM de destino:',
  'ops.sim.rate': 'Tarifa: ${input}/1M entrada · ${output}/1M salida',
  'ops.sim.inputTokens': 'Tokens de entrada (prompt):',
  'ops.sim.outputTokens': 'Tokens de salida (completion):',
  'ops.sim.summary': 'Resumen de la inyección:',
  'ops.sim.totalTokens': '{value} tokens totales',
  'ops.sim.cachedValue': '{value} en caché',
  'ops.sim.costValue': '${value} USD',
  'ops.sim.fire': 'Disparar inferencia en vivo',
  'ops.sim.banner': 'Simulación. Estas llamadas no se envían a ningún modelo y no cuentan en ningún total.',
  'ops.sim.rateUnknown': 'Tarifa: desconocida',
  'ops.sim.estimatedLabel': 'Tarifa del catálogo de demostración (estimada)',

  // Agents tab
  'ops.agents.heading': 'Reasignación interactiva de modelos a agentes',
  'ops.agents.subtitle':
    'Cambia en tiempo real el modelo o proveedor asignado a cada agente. Sus próximas inferencias se contabilizarán en el nodo correspondiente.',
  'ops.agents.col.agent': 'AGENTE',
  'ops.agents.col.role': 'ROL',
  'ops.agents.col.provider': 'PROVEEDOR ACTUAL',
  'ops.agents.col.model': 'MODELO ASIGNADO',
  'ops.agents.col.tokens': 'TOKENS ACUMULADOS',
  'ops.agents.col.action': 'ACCIÓN',
  'ops.agents.modelSelect': 'Modelo asignado a {name}',
  'ops.agents.focus': 'Centrar cámara',
  'ops.agents.focusAria': 'Centrar cámara en {name}',
  'ops.agents.readOnlyLive': 'El portal no puede cambiar el modelo de un agente remoto.',

  // Feed tab
  'ops.feed.simulated.heading': 'Llamadas simuladas',
  'ops.feed.simulated.empty': 'Ejecuta el simulador para ver ejemplos de llamadas aquí.',
  'ops.feed.emit': 'Emitir petición',
  'ops.feed.by': 'por',
  'ops.feed.operator': 'Operador del simulador',
  'ops.feed.col.tokens': 'TOKENS',
  'ops.feed.col.latency': 'LATENCIA',
  'ops.feed.col.cost': 'COSTO',

  // Insignia de simulado, en cada elemento simulado: fila del feed, resumen del simulador, aviso, burbuja
  'ops.badge.simulated': 'SIMULADO',

  // Footer
  'ops.footer.tip': 'Consejo:',
  'ops.footer.tipText':
    'Haz clic en los racks de servidores o en la pantalla NOC de la sala Model Ops de la oficina para abrir este panel.',
  'ops.footer.close': 'Cerrar',

  // Fuente de datos (issue #79): ledger real o datos simulados de la demo
  'ops.mode.ledgerStatus': 'Ledger, actualizado a las {time}',
  'ops.mode.simulatedBadge': 'Simulado',
  'ops.banner.simulatedData':
    'Datos simulados de la demo. Estas cifras provienen del estado local de la demo, no del ledger de uso.',

  // Franja de estadísticas en modo ledger
  'ops.stats.reportedCost': 'Costo reportado',
  'ops.stats.calls': 'Llamadas',
  'ops.stats.failedCalls': 'Llamadas fallidas',

  // Valores desconocidos / parciales / multi-moneda, compartido por Matrix, Agentes y Flujo
  'ops.value.na': 'n/d',
  'ops.value.partial': 'parcial',
  'ops.value.partialTitle': '{unreported} de {total} llamadas no reportaron este dato',
  'ops.cost.unknownCalls': '{count} llamadas sin costo',
  'ops.cost.source.estimated': 'estimado',
  'ops.cost.source.unknown': 'fuente desconocida',
  'ops.sort.costDisabledTitle': 'Ordenar por costo no está disponible: las filas mostradas mezclan monedas o fuentes de costo.',

  // Pestaña Matriz, modo ledger
  'ops.matrix.timeRange.label': 'Rango de tiempo:',
  'ops.matrix.timeRange.all': 'Todo el tiempo',
  'ops.matrix.timeRange.last24h': 'Últimas 24 horas',
  'ops.matrix.timeRange.last7d': 'Últimos 7 días',
  'ops.matrix.truncated': 'Mostrando los {count} grupos principales por tokens.',
  'ops.matrix.col.calls': 'LLAMADAS',
  'ops.matrix.col.failedCalls': 'FALLIDAS',
  'ops.matrix.col.input': 'ENTRADA',
  'ops.matrix.col.output': 'SALIDA',
  'ops.matrix.col.cacheRead': 'LECTURA DE CACHÉ',
  'ops.matrix.col.cacheWrite': 'ESCRITURA DE CACHÉ',
  'ops.matrix.col.reasoning': 'RAZONAMIENTO',
  'ops.matrix.col.cost': 'COSTO',

  // Pestaña Agentes, modo ledger
  'ops.agents.ledger.heading': 'Consumo por agente y modelo',
  'ops.agents.ledger.subtitle': 'Desde el ledger de uso: una fila por cada agente y modelo realmente invocado.',
  'ops.agents.col.calls': 'LLAMADAS',
  'ops.agents.col.failedCalls': 'FALLIDAS',
  'ops.agents.col.cost': 'COSTO',
  'ops.agents.noUsage': 'Sin consumo reportado',
  'ops.agents.unattributed': 'Sin atribuir',

  // Pestaña Flujo, modo ledger
  'ops.feed.ledger.heading': 'Llamadas recientes a modelos',
  'ops.feed.ledger.loadMore': 'Cargar más',
  'ops.feed.ledger.loading': 'Cargando más...',
  'ops.feed.ledger.col.time': 'HORA',
  'ops.feed.ledger.col.model': 'MODELO',
  'ops.feed.ledger.col.agent': 'AGENTE',
  'ops.feed.ledger.col.status': 'ESTADO',
  'ops.feed.ledger.col.tokens': 'TOKENS',
  'ops.feed.ledger.col.latency': 'LATENCIA',
  'ops.feed.ledger.col.cost': 'COSTO',
  'ops.feed.ledger.costUnknown': 'Costo no reportado',
  'ops.feed.ledger.filter.status': 'Estado:',
  'ops.feed.ledger.filter.statusAll': 'Todas',
  'ops.feed.ledger.filter.statusFailed': 'Fallidas',
  'ops.feed.ledger.filter.model': 'Modelo:',
  'ops.feed.ledger.filter.agent': 'Agente:',
  'ops.feed.ledger.filter.allModels': 'Todos los modelos',
  'ops.feed.ledger.filter.allAgents': 'Todos los agentes',
  'ops.feed.ledger.unattributed': 'Sin atribuir',
  'ops.feed.ledger.detailTitle': 'evento {eventId} / sesión {sessionId}',

  // Estados vacíos y de error, compartidos por Matriz, Agentes y Flujo en modo ledger
  'ops.empty.loading': 'Cargando datos de uso...',
  'ops.empty.unavailable': 'Este servidor no expone el ledger de uso. Actualiza el servidor de Agent Viewer a la versión 0.4.0 o posterior.',
  'ops.empty.unauthorized': 'El servidor requiere un token de API. Configúralo para el portal.',
  'ops.empty.networkError': 'No se pudo contactar al servidor.',
  'ops.empty.retry': 'Reintentar',
  'ops.empty.noCalls.heading': 'Todavía no se ha registrado ninguna llamada a un modelo',
  'ops.empty.noCalls.intro': 'Envía un evento llm.usage real y aparecerá aquí.',
  'ops.empty.noCalls.curlHeading': 'Desde la línea de comandos:',
  'ops.empty.noCalls.pythonHeading': 'Desde el SDK de Python:',
  'ops.empty.noCalls.typescriptHeading': 'Desde el SDK de TypeScript:',
  'ops.empty.noCalls.docsLink': 'Lee la guía de integración',
  'ops.empty.noCalls.naNote': 'Los campos que omitas se muestran como "n/d", nunca como cero.',
  'ops.empty.filtered': 'Ninguna llamada coincide con los filtros actuales.',
  'ops.empty.clearFilters': 'Limpiar filtros',
};

export const MODEL_OPS_MESSAGES = { en: EN, es: ES };
