
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
