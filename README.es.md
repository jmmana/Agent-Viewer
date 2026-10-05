# Agent Viewer

**Mira cómo trabajan tus agentes de IA.**

Agent Viewer es un framework visual y open source para observar sistemas multiagente como una oficina viva. Los agentes trabajan en salas con significado operativo, se mueven según su estado, se reúnen, muestran actividad observable y permiten entender qué modelos están usando y cuánto consumen.

> El README principal en inglés es la fuente canónica del proyecto: [README.md](README.md)

## Visión

La meta no es crear únicamente una oficina pixel-art bonita. Agent Viewer debe ayudar a responder visualmente:

- ¿Qué agente está trabajando?
- ¿En qué tarea está?
- ¿Dónde está dentro del flujo?
- ¿Con qué otros agentes está colaborando?
- ¿Qué proveedor y modelo está usando?
- ¿Cuántos tokens está consumiendo?
- ¿Cuánto está costando?
- ¿Está trabajando, esperando, bloqueado, reunido o inactivo?

## Oficina viva

- movimiento de agentes según estado
- llamadas visibles antes de reuniones
- Sala de Reunión A
- Sala de Reunión B como overflow
- oficina del Director como fallback si las salas están ocupadas
- agentes inactivos que pueden ir al café
- conversaciones ambientales claramente marcadas
- chistes y temas sociales según idioma/configuración
- estados visuales de ánimo como feliz, divertido, sorprendido o molesto
- una sala Model Ops con estética de servidores y telemetría de proveedores, modelos, tokens y costos

La actividad social nunca debe confundirse con mensajes reales del runtime conectado.

## Model Ops

La antigua sala pasiva de infraestructura evoluciona hacia un **Model Ops / Token Operations Center**.

Debe mostrar, cuando exista la información:

- proveedor
- modelo
- solicitudes
- tokens de entrada
- tokens de salida
- tokens cacheados
- costo
- latencia
- errores
- agentes asociados al consumo

Los valores desconocidos no deben mostrarse como cero.

## Integración

Agent Viewer está diseñado para visualizar agentes existentes, no para obligarte a reemplazar tu orquestador.

La dirección de integración contempla:

- REST para registro, snapshots e ingestión
- WebSocket o SSE para actualizaciones en tiempo real
- SDK TypeScript/JavaScript
- SDK Python
- eventos versionados y vendor-neutral

Consulta [docs/integration.md](docs/integration.md).

## Especificación

El comportamiento funcional de la oficina está documentado en [docs/specs/living-office.md](docs/specs/living-office.md).

La especificación separa estado operativo real de estado de presentación/animación. De esta forma, caminar, tomar café o mostrar una emoción no modifica silenciosamente el estado real de una tarea.

## Idiomas

El idioma fuente del proyecto es inglés. La arquitectura de internacionalización comienza con inglés (`en`) y español (`es`). Los IDs semánticos, estados, eventos, modelos y proveedores no se traducen; solo se traducen etiquetas visibles, tooltips, nombres de salas y contenido ambiental.

## Ejecutar localmente

Requiere Node.js 24.

```bash
git clone https://github.com/jmmana/Agent-Viewer.git
cd Agent-Viewer
npm ci
npm run dev
```

Luego abre `http://localhost:3000`.

## Estado actual

El repositorio contiene una simulación local funcional. La integración pública para runtimes externos todavía se está construyendo. Los issues AV-001 a AV-007 definen el trabajo spec-driven para convertir la demo actual en el framework de oficina viva.

## Autor

Creado por **Juan Manuel Castillo Pinto / WarlockCode**.

Agent Viewer busca ser gratuito, descargable y construido junto con la comunidad.
