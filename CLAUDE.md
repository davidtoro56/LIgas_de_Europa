
## Verificación de calidad: `verificar_proyecto.js`

Hay un script de chequeo rápido en esta carpeta (`node verificar_proyecto.js`) que
corre en segundos y valida: sintaxis del JS, integridad de IDs del HTML, que los
nombres de equipo en `resultsDB`/`marketOddsDB` coincidan con `teams{}` de cada
liga, y calcula **eficacia real** (Brier Score contra los resultados reales que
ya haya en `resultsDB`) y **eficiencia** (velocidad de cómputo).

**Correlo automáticamente después de cualquier edición a `poisson-multiliga.html`**
— no hace falta que se lo pidan explícitamente. Si algo falla, mostrar el error
completo antes de dar la tarea por terminada.

**Sobre el número de eficacia (Brier Score):** con pocos resultados reales
(N<20) el script mismo lo marca como "chequeo de sanidad, no validación" — no
sacar conclusiones de un Brier alto o bajo hasta que la muestra crezca. No es
necesario alertar sobre esto cada vez, el script ya lo aclara solo.

**Esto NO reemplaza las 24 suites de test completas** (esas viven en la
conversación de navegador con Claude, con 484 verificaciones acumuladas). Es un
chequeo liviano para detectar problemas obvios entre sesiones de Code — si se
hace un cambio estructural grande (nueva fase del modelo, nueva liga, cambio de
arquitectura), avisar para que se audite también del lado del chat.

## Reentrenamiento automático del modelo de stacking: `reentrenar_stacking.js`

El motor de 1X2 usa un modelo de stacking (regresión logística, `STACKING_W`/
`STACKING_B`) en vez de una fórmula fija. Este script lo reentrena combinando
la base histórica 25-26 (`historico_25_26.json`) con los resultados reales de
la 26-27 que ya haya en `resultsDB` — que se van acumulando solos con la
rutina semanal de `extraer_resultados.js`.

**SALVAGUARDA CENTRAL, no tocar esta lógica sin discutirlo primero:** el script
entrena un candidato y lo compara contra el modelo actual en un tercio de
datos que NINGUNO de los dos vio durante su entrenamiento (split cronológico
70/30). Solo actualiza `poisson-multiliga.html` si el candidato mejora por
más de 0.3% (umbral `MIN_IMPROVEMENT_PCT` en el propio script) — si no, no
toca nada y lo dice explícitamente. Esto evita que el modelo empeore
silenciosamente por sobreajustar a ruido de poca muestra.

**Cadencia recomendada: no correrlo en cada pasada de mantenimiento semanal.**
A diferencia de `extraer_resultados.js`/`extraer_cuotas.js`, reentrenar tiene
sentido con menos frecuencia — sugerido: una vez por mes, o cuando `resultsDB`
acumule al menos ~50-100 partidos nuevos desde la última vez que se corrió
(lo que pase primero). Con pocos partidos nuevos (como los primeros del
arranque de temporada) es normal y esperable que el script decida NO
actualizar nada — eso es correcto, no un fallo.

**Si actualiza el archivo:** correr `verificar_proyecto.js` inmediatamente
después para confirmar que todo sigue íntegro, y mencionarlo en el resumen
final para que quede trazado del lado del chat también.

## ACTUALIZACIÓN IMPORTANTE: esquema nuevo de resultsDB (desglose local/visitante)

`resultsDB` cambió de esquema recientemente. **YA NO** usa totales combinados
(`corners`, `sot`, `cards`) — ahora usa el desglose local/visitante:

```js
"Equipo Local||Equipo Visitante": {
  homeGoals: 2, awayGoals: 0,
  homeCorners: 6, awayCorners: 3,
  homeSOT: 5, awaySOT: 2,
  homeCards: 1, awayCards: 2,
  date: "2026-08-19"
}
```

**Por qué:** habilita el aprendizaje por equipo en corners/tiros/tarjetas
(`recomputeMarketStrengths`), que necesita saber cuánto generó CADA equipo,
no solo el total del partido. `extraer_resultados.js` (versión actual, la
que usa `splitStat` en vez de `sumStat`) ya devuelve este desglose — **no
sumar home+away al escribir en resultsDB**, guardar los 6 campos separados
tal como vienen del script.

Si en algún momento aparecen entradas viejas en `resultsDB` con el esquema
anterior (`corners`/`sot`/`cards` como total único), **son incompatibles**
y hay que volver a extraerlas con `extraer_resultados.js` actualizado — no
se puede reconstruir el desglose a partir del total.

**Si esta sección contradice algo que viste en una corrida anterior de Code
sobre esquema de resultsDB, esta es la versión correcta y más reciente.**

## ACTUALIZACIÓN: tarjetas ahora también dependen del rival

Hasta hace poco, `predCards` solo dependía de la tendencia propia del equipo
(y su situación), sin ningún término del rival — inconsistente con goles/
corners/tiros, que sí ajustan por el rival específico. Se corrigió agregando
`OPPONENT_CARDS_INFLUENCE=0.4`: el `cardsRatio` normalizado del rival
(combatividad relativa a la liga) influye moderadamente en las tarjetas
propias, capturando el efecto de "partido caliente" entre dos equipos que
cometen muchas faltas. No confundir con ataque/defensa (no hay ese mecanismo
causal en tarjetas) -- es un efecto de contagio de intensidad, con peso menor
(0.4) que corners/tiros (1.0) porque es criterio propio, no algo con el mismo
respaldo que Dixon-Coles.

## Nueva funcionalidad: Top 10 por confianza (multi-liga)

Botón "🏆 Top 10 por confianza" arriba del selector de equipos. Recorre las
5 ligas, junta los partidos programados en la ventana de próximos días, y
muestra los 10 con mayor índice de confianza en 1X2 -- pensado como
herramienta de DECISIÓN, no de apuesta automática. Cada fila muestra liga,
equipos, fecha, resultado más probable, score de confianza, y el edge contra
el mercado si hay cuota cargada (con aviso si está vieja).

**Importante si se toca esta función:** `topConfidenceFixtures()` recorre las
5 ligas llamando `switchLeagueState()` repetidamente, y restaura la liga
original al terminar -- ya probado que no "deja pegado" el estado ni mezcla
el aprendizaje entre ligas. Cualquier cambio acá debe preservar ese
comportamiento (hay test específico: `test_top_confidence.js`, bloques C y D).

## Extensión: Top 10 con 4 índices combinados + Top discrepancia de mercado

`topConfidenceFixtures()` ahora ordena por `confCombined` (promedio de los 4
índices: goles, corners, tiros, tarjetas), no solo por goles. Cada resultado
expone los 4 por separado (`confGoals/confCorners/confSOT/confCards`) además
del combinado, para que un promedio alto no esconda un mercado puntual flojo.

Nueva función `topMarketDiscrepancies()` (botón "⚡ Top 10 discrepancia con
el mercado"): ranking INDEPENDIENTE del de confianza, ordenado por magnitud
de diferencia contra la cuota (`maxAbsEdge`, siempre positivo). Solo incluye
partidos con cuota real cargada en `marketOddsDB` -- si no hay ninguna,
devuelve lista vacía y el panel lo indica con un mensaje, no un error.

Ambas funciones recorren las 5 ligas con `switchLeagueState()` y restauran
la liga original al terminar -- mismo cuidado que la versión anterior,
verificado con test específico (`test_top_extended.js`, bloque F).

## Extensión: cuotas de corners, tiros a puerta y tarjetas (no solo 1X2/goles)

`extraer_cuotas.js` ahora también trae `match_corners`, `total_cards` y
`match_shots_on_target` de TheStatsAPI. A diferencia de goles (línea fija
2.5), estos mercados no tienen línea estándar -- el script junta todas las
líneas que ofrecen las casas, promedia entre las que coinciden en la misma
línea, y usa la MÁS LÍQUIDA (más casas de acuerdo) como referencia.

`marketOddsDB` ahora acepta campos opcionales `corners`/`cards`/`sot`, cada
uno `{line, over, under, bookmakers}`. Nueva función `compareMarketsToOdds()`
convierte la predicción del modelo (ej. "10.7 corners esperados") a
probabilidad de over/under ESA línea usando Poisson, y calcula el edge igual
que ya se hacía para 1X2. Se muestra en el mismo panel de mercado.

**No existe mercado de tarjetas por equipo** (solo total del partido) según
la documentación de la API -- por eso `cards` no tiene desglose local/
visitante como sí lo tienen `corners` y `sot` en la respuesta de la API (que
por ahora no se está usando, solo el total del partido, para simplicidad).

## ACTUALIZACIÓN: OPPONENT_CARDS_INFLUENCE pausado en 0 (era 0.4)

Backtesteado con 972 partidos reales de tarjetas (desglose local/visitante,
temporada 25-26 completa vía historico_completo_25_26.json). El mecanismo de
"partido caliente" entre rivales combativos NO mostró soporte empírico: en
train, más peso al rival predecía sistemáticamente peor (patrón monótono);
en test, la diferencia entre 0 y 0.4 fue de 0.02% y cambió de signo -- ruido,
no señal.

Se pausó en 0, NO se borró el mecanismo (`cardsRatio`, la lógica de
`rivalFactorForHome/Away` siguen intactas en el código). Reactivar solo si
se re-corre el mismo backtest con más datos de la 26-27 y muestra soporte
real -- no volver a 0.4 por intuición sin evidencia nueva.

**IMPORTANTE:** hay un bug ya corregido en `extraer_historico_completo.js`
que vale la pena conocer si se vuelve a usar ese script: la primera corrida
guardó los partidos SIN ordenar cronológicamente (el bug: faltaba el
`.sort()` que sí tenía `extraer_historico_25_26.js`). Ya está arreglado en
el script, pero si alguna vez aparece un archivo de histórico completo
nuevo, verificar el orden de fechas antes de usarlo para backtesting --
un histórico desordenado invalida cualquier walk-forward.

## PENDIENTE PARA CUANDO ARRANQUE LA 27-28: reconstruir el prior

Hoy el prior fijo (`teams{}`, usado por `computeLeagueDerived`) está construido
SOLO con la temporada 25-26 completa. Esto NO se actualiza solo -- a
diferencia del aprendizaje in-season (que decae solo con `HALF_LIFE_DAYS`),
el prior queda congelado hasta que alguien lo reconstruya a mano.

**Decisión ya tomada, no hace falta volver a discutirla cuando llegue el
momento:** el prior de la 27-28 va a ser el **promedio simple** de las
temporadas 25-26 y 26-27 completas (peso 50/50, no ponderado por
recencia). Se descartó deliberadamente un esquema más sofisticado
(ponderación decreciente por temporada, tipo ClubElo) por complejidad --
si en el futuro se quiere revisar esa decisión, habría que backtestear
igual que hicimos con HALF_LIFE_DAYS/XG_WEIGHT antes de cambiarla, no
adoptarla por intuición.

**Pasos para ejecutar esto cuando corresponda (mayo/junio 2027,
aproximadamente):**

1. Extraer la temporada 26-27 completa de TheStatsAPI, mismo patrón que
   `extraer_stats_v5.js` usó para la 25-26 (gf/ga/xg/xga/cf/ca/sf/sa/cards
   por equipo, temporada completa)
2. Para cada equipo presente en AMBAS temporadas (25-26 y 26-27): promediar
   sus stats crudas de las dos temporadas antes de normalizar contra el
   promedio de liga (no promediar los `attack`/`defense` ya normalizados,
   promediar gf/ga/xg/xga/etc. primero, período por período, como en el
   armado original)
3. Para un equipo presente en SOLO UNA de las dos temporadas (recién
   ascendido a la 26-27, o que jugó 25-26 pero se fue de la liga): usar
   directamente los datos de la única temporada que tenga, sin promediar
   con nada -- no inventar un promedio con datos que no existen
4. Actualizar `active[]`/ascensos-descensos de la 27-28 (mismo proceso
   manual que se hizo al arrancar la 26-27: 3 nuevos ascendidos con prior
   estimado por liga, sacar los 3 descendidos de `active`)
5. Revisar `TRANSFER_FX` de cero -- los fichajes relevantes van a ser
   completamente distintos, investigación puntual nueva
6. Una vez reconstruido el prior, correr TODA la batería de tests de
   nuevo (sintaxis, nombres, los ~30 suites) antes de publicar -- es un
   cambio que toca el corazón del modelo, mismo cuidado que cualquier
   cambio de esa magnitud documentado en este archivo

**Lo que NO hace falta tocar manualmente:** `HALF_LIFE_DAYS`, `XG_WEIGHT`,
`DC_RHO`, `PRIOR_STRENGTH`, el modelo de stacking, y el resto de las
constantes ya validadas con backtesting -- esas siguen siendo válidas
temporada tras temporada, no están atadas a los datos de una temporada
específica.

## Nueva funcionalidad: "Combinación más segura de este partido"

Panel nuevo, visible siempre (no oculto como batchPanel/calibrationPanel),
justo debajo del índice de confianza de goles. Compara 1X2, corners y
tarjetas del partido actualmente seleccionado, y señala cuál de los 3 tiene
el pronóstico más alejado de un resultado parejo.

**Regla central, no tocar sin pensarlo dos veces:** filtra los mercados de
confianza "baja" ANTES de comparar probabilidades. Una probabilidad extrema
sacada de datos poco confiables (por ejemplo, un ascendido sin historial)
NO debe ganarle a una probabilidad más moderada pero con datos sólidos. Si
los 3 mercados tienen confianza baja, lo dice explícitamente en vez de
elegir uno igual sin avisar.

`probOverLine` se sacó de adentro de `compareMarketsToOdds` a función
global, porque ahora también la usa `safestMarketForMatch` -- si se toca
una, revisar que la otra siga funcionando (hay test compartido:
`test_safest_market.js`).

Es información, no una recomendación de apuesta -- el disclaimer viaja
siempre con el panel, igual que en el resto de las funciones de mercado.

## BUG CORREGIDO: duplicación de opciones en selectores

`leagueSel` (el selector de liga) le faltaba `innerHTML = ''` antes de
poblarse con `appendChild` en un `forEach`. Esto no daba problema mientras
el archivo se distribuyera "limpio" (con `<select id="leagueSelect"></select>`
vacío) -- pero si alguna vez el archivo se guarda desde el navegador
DESPUÉS de que el JS ya corrió (por ejemplo, "Guardar como" en vez de
descargar el archivo fuente), el HTML guardado incluye las opciones que el
JS ya había insertado. Al volver a abrir ese archivo, el JS corre de nuevo
y las duplica -- cada liga aparecía 2 veces en el desplegable.

**Ya corregido con una limpieza defensiva antes del forEach** (ver el
comentario en el propio código, cerca de `const leagueSel`).
`populateTeamSelects()` ya tenía esta protección desde antes -- por eso
los selectores de equipo nunca mostraron el mismo problema.

**Lección para evitar que esto se repita:** si en algún momento alguien
reporta datos "duplicados" o "el doble de lo esperado" en la interfaz,
revisar primero si hay algún `appendChild` en un loop sin `innerHTML = ''`
antes -- es un patrón de bug fácil de reintroducir sin querer al copiar
código similar en otro lado.

**Aviso práctico:** al bajar el archivo publicado en GitHub Pages para
usarlo como base de edición (en vez de pedirlo directo acá), preferir el
botón de descarga del archivo fuente si existe, o verificar que los
`<select>` estén vacíos en el HTML crudo antes de asumir que el archivo
está "limpio" -- esto es lo que pasó acá: se usó sin darse cuenta una copia
ya contaminada como base para varios cambios posteriores.

## BUG CORREGIDO: "Combinación más segura" siempre daba "Tarjetas Under 5.5"

`safestMarketForMatch` comparaba varias líneas candidatas (2.5/3.5/4.5/5.5
para tarjetas, 7.5-11.5 para corners) y elegía la de probabilidad más
extrema. Esto estaba SESGADO: con promedios de tarjetas rondando 3-5, la
probabilidad de superar la línea más alta testeada (5.5) casi siempre era
baja, así que "Under 5.5" ganaba en casi todos los partidos -- no era una
señal real del partido, era un artefacto de comparar contra un set de
líneas asimétrico respecto a la media típica.

**Corregido usando UNA sola línea de referencia fija por mercado** (9.5
corners, 3.5 tarjetas -- las mismas que ya usa el resto de la UI), no
varias candidatas. Verificado con 6 partidos distintos que el pick ahora
varía genuinamente (antes: siempre "Under 5.5"; ahora: mezcla real de
Over/Under 3.5 según el partido). Test de regresión específico:
`test_safest_market.js`, bloque H.

**Lección para el futuro:** cualquier función que "elija la línea más
extrema entre varias candidatas" corre este mismo riesgo de sesgo si el
set de líneas no es simétrico respecto a los valores típicos que puede
tomar la predicción. Preferir una línea fija de referencia salvo que haya
una razón real para escanear varias.

## BUG CORREGIDO: no se podía elegir el mismo equipo en Local y Visitante

`render()` no validaba que Local ≠ Visitante -- se podía elegir "Arsenal vs
Arsenal" y el motor calculaba algo sin sentido en vez de avisar. Corregido
en dos niveles:
1. `render()` corta al principio si son el mismo equipo, muestra un aviso
2. `syncTeamExclusion()` (nueva función): hace IMPOSIBLE elegirlo desde el
   selector -- cada vez que se elige un equipo en Local, se deshabilita esa
   opción en Visitante, y viceversa. Se llama en cada `change` de ambos
   selectores y al repoblar tras cambiar de liga.

## NUEVA FUNCIONALIDAD: selector de calendario real

Dropdown nuevo (`fixtureSelect`) arriba de los selectores manuales, con los
partidos REALES programados de `L().fixtures`, ordenados por fecha. Al
elegir uno, setea Local/Visitante automáticamente -- resuelve de paso el
problema de armar enfrentamientos que nunca van a jugarse. Los selectores
manuales siguen disponibles debajo por si se quiere explorar una
combinación hipotética; si se tocan a mano, el selector de calendario
vuelve a "Selección manual" para no mostrar un partido que ya no coincide.

## REGRESIÓN ENCONTRADA Y CORREGIDA: OPPONENT_CARDS_INFLUENCE había vuelto a 0.4

Durante la migración a GitHub, en algún punto del ida y vuelta de archivos
(probablemente al usar como base un archivo bajado con "Guardar como" de
un momento anterior a esta decisión), `OPPONENT_CARDS_INFLUENCE` volvió a
0.4 -- perdiendo la pausa que habíamos decidido tras el backtest real con
972 partidos. Ya restaurado a 0, con la documentación completa de vuelta.

**Se auditaron las demás constantes documentadas** (HALF_LIFE_DAYS,
XG_WEIGHT, DC_RHO, PRIOR_STRENGTH, STACKING_W/B, datos de Premier League)
y ninguna otra sufrió el mismo problema -- fue puntual a esta constante.

**Lección para el futuro:** cuando se use como base un archivo bajado de
la URL pública o subido por el usuario (en vez de la copia que ya se
tiene), vale la pena correr `verificar_proyecto.js` Y revisar manualmente
las constantes clave documentadas en este archivo antes de seguir editando
encima -- no asumir que "es el archivo real" significa "tiene todos los
cambios".
