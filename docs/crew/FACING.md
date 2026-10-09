# Orientación de actores Crew

Relacionado: #118, #117 y #155. El renderer lee `Agent.facing` sin modificar agentes, eventos, posiciones, cámara ni métricas. No genera eventos de giro y no deriva una ruta de locomoción.

La dirección se expresa en los ejes locales usados por crewProject: SE = +X, SW = +Y, NW = -X, NE = -Y. El arte frontal representa SE, el lateral izquierdo SW, el posterior NW y el lateral derecho NE. Es una convención discreta del piloto 2.5D, no una rotación continua del bitmap.

| Facing del snapshot | Cámara front | Cámara right | Cámara back | Cámara left |
| --- | --- | --- | --- | --- |
| SE | front | left | back | right |
| SW | left | back | right | front |
| NW | back | right | front | left |
| NE | right | front | left | back |

La cámara right transforma +X en +Y; por eso un CEO SE se ve con el sprite izquierdo. La etiqueta de cámara identifica la vista de la sala, no la orientación del rostro. Cada actor resuelve su imagen por separado. Una imagen se comparte entre los actores que la necesitan en la misma escena, y se libera al dejar de requerirse. Los fallos afectan solo a los actores que necesitan esa orientación.

Si el campo falta se utiliza SE, la dirección inicial del dominio existente. Un valor desconocido utiliza el marcador. El parpadeo se aplica únicamente cuando la orientación resultante es front, incluso si la cámara seleccionada es right, back o left.

Pruebas: matriz de 16 combinaciones; snapshot congelado sin mutaciones; carga compartida y cancelación selectiva; dibujo de frente animado y espalda estática en la misma cámara; E2E de cuatro CEO con sus cuatro orientaciones, cambio de cámara y actualización del primer agente. La fixture está rotulada DEMO y se ejecuta sobre el renderer Crew real, fuera de la aplicación compilada.

Pendientes: el adaptador de eventos no incorpora un nuevo mensaje facing; los snapshots actuales que conservan SE siguen usando ese valor. Giros interpolados, locomoción por rutas locales, anti-foot-slide y clips de caminar permanecen pendientes. Esto no cierra los criterios de #118 ni certifica G1.
