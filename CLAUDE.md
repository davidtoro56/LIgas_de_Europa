
## BUG CRÍTICO CORREGIDO: la recalibración de corners/tiros/tarjetas nunca funcionó

Encontrado al investigar por qué La Liga (primera liga en llegar a 30
partidos reales) mostraba `calibration.active: true` pero los factores de
corrección daban `N=0` en los tres mercados secundarios.

**La causa:** `computeBiasFactor` buscaba `r.actual.corners` (un campo TOTAL
único) -- pero desde la migración de esquema a desglose local/visitante
(mucho antes en el proyecto), `resultsDB` solo tiene `homeCorners`/
`awayCorners` separados. Ese campo `corners` combinado nunca existió en el
esquema nuevo. `settleAgainstDB` calculaba el total localmente pero nunca lo
guardaba en `record.actual` -- solo lo usaba para `cornersErr`/`sotErr`/
`cardsErr`. Resultado: la recalibración de mercados secundarios estuvo
completamente rota desde que migramos el esquema, sin que ningún test lo
detectara (los tests sintéticos usaban datos de prueba que no reproducían
el problema real).

**Corregido:** `computeBiasFactor` ahora recibe DOS claves (home/away) en
vez de una, y suma internamente -- igual criterio que ya usaba
`settleAgainstDB` para los errores. Verificado con los 30 partidos reales
de La Liga: ahora `cRaw.n/sRaw.n/kRaw.n` = 30 en los tres mercados
(sesgos detectados: corners +3.5%, tiros +3.6%, tarjetas +4.4%).

**Lección para el futuro:** cuando se migra un esquema de datos, hay que
auditar TODOS los lugares que leen el campo viejo, no solo los que se
tocan directamente en el cambio -- este bug estuvo invisible durante
semanas porque `active` se ponía en `true` correctamente (esa parte sí
usaba el campo correcto, `settled.length`), dando una falsa sensación de
que todo funcionaba.

## MEJORA PREVENTIVA: goalsOverUnder() expuesto globalmente

No era un bug de producción -- el código real (`render()`) siempre calculó
over/under de goles correctamente, sumando las celdas de la matriz de
Dixon-Coles donde `local+visitante > línea`. Pero ese cálculo vivía
escondido adentro de `render()`, sin ser reutilizable. Al armar un análisis
de "asertividad" por fuera del artifact, se usó por comodidad la
aproximación de Poisson simple (`probOverLine`, correcta para corners/
tiros/tarjetas, que no tienen matriz conjunta) -- y esa aproximación da
resultados MAL sesgados para goles específicamente (el modelo "decía
Over 2.5" en ~1% de los casos, en vez del ~55% real).

**Se agregó `goalsOverUnder(homeXG, awayXG, lines)`** como función global,
con el método correcto (matriz real, no aproximación). `computeForecast()`
ahora expone `over15`/`over25`/`over35` directamente en su resultado, para
que cualquier análisis futuro (acá o en un script nuevo) use el método
correcto por defecto, sin tener que acordarse de la diferencia.

**Regla para recordar, documentada acá para no repetir el error:**
`probOverLine()` (Poisson simple) es válida SOLO para corners/tiros/
tarjetas (no tienen matriz conjunta calculada). Para GOLES, siempre usar
`goalsOverUnder()` (o el campo `over25`/etc. ya expuesto en
`computeForecast()`) -- nunca `probOverLine(homeXG+awayXG, línea)`.

Test de regresión: `test_goals_ou.js`.

## NUEVA FUNCIONALIDAD: calibración del NIVEL de goles (no solo la forma del 1X2)

Encontrado un hueco real: `calibration.temp` (ya existente) corrige la FORMA
de la distribución 1X2, pero el total de goles esperado (`homeXG+awayXG`,
lo que alimenta over/under) nunca pasaba por ningún mecanismo de
recalibración. Con datos reales de la 26-27 (146 partidos), se encontró un
sesgo agregado real: el modelo predecía "Over 2.5" en 51.2% de los casos,
la frecuencia real fue 58.2% -- una subestimación sistemática de ~7pp.

**Agregado `calibration.goals`**, mismo patrón que corners/tiros/tarjetas
(`computeBiasFactor` + `shrinkToPrior` + `clampAdjustment`, por liga, activo
recién con 30+ partidos). Se aplica multiplicando homeXG Y awayXG
DIRECTAMENTE por el factor (no raíz cuadrada -- factor*(a+b) = factor*a +
factor*b, así el total escala exacto). Verificado con test específico que
confirma la multiplicación exacta, no una aproximación.

**Dato real, no simulado:** con los 30 partidos reales de La Liga, el
factor encontrado es 1.0035 (chico) -- mucho menor que el -7pp visto
agregando las 5 ligas juntas. Esto es CORRECTO y esperable: la medición
agregada mezclaba ligas con y sin calibración activa; el sistema por liga
encuentra el sesgo específico de cada una, más preciso que un promedio
global. A medida que Premier League, Serie A, Ligue 1 y Bundesliga
acumulen sus propios 30 partidos, cada una va a tener su propio factor de
goles, no uno compartido.

**Dónde se aplica:** tanto en `render()` como en `computeForecast()`, ANTES
de mostrar/calcular la matriz -- lo que se ve en pantalla y lo que devuelve
`computeForecast()` (incluido `over15`/`over25`/`over35`, agregado en el
cambio anterior) ya viene con esta corrección aplicada.

Test de regresión: `test_goals_calibration.js`.

## BUG CRÍTICO CORREGIDO: learnedMarketStrength se filtraba entre ligas al cambiar

Encontrado al verificar (a pedido del usuario, buena pregunta que destapó
esto) si el sistema realmente usa SOLO los datos de la liga seleccionada
en cada momento. Todo lo demás estaba bien (`window.storage.list('pred_' +
L().code + '_')` filtra desde el origen; `learnedStrength`/`eloRatings`/
`calibration` se guardaban y restauraban correctamente por liga) -- pero
`switchLeagueState` nunca guardaba ni restauraba `learnedMarketStrength`
(el aprendizaje por equipo de corners/tiros/tarjetas).

**El problema práctico:** la secuencia real al cambiar de liga es
`switchLeagueState()` → `render()` (inmediato) → recién después
`await refreshHistory()` (asíncrono). Sin el fix, ese primer `render()`
corría con el aprendizaje de mercados de la liga ANTERIOR -- no se
mezclaban resultados de equipos con nombres coincidentes (no los hay entre
ligas), pero el aprendizaje quedaba temporalmente mal scopeado hasta que
`refreshHistory()` terminaba.

**Corregido:** `switchLeagueState` ahora guarda/restaura
`learnedMarketStrength` con el mismo patrón que ya usaban las otras tres
propiedades (`marketLearningByLeague`, que ya existía pero nunca se leía
-- solo se escribía).

**De paso, se corrigió otro descuido menor:** el objeto de fallback de
`calibration` en `switchLeagueState` no incluía `goals:1` (agregado en el
cambio anterior de calibración de goles) -- ya corregido también.

Test de regresión: `test_market_league_switch.js` -- prueba exactamente el
escenario del bug (cambiar de liga y consultar ANTES de que
`recomputeMarketStrengths` vuelva a correr).

## Nueva clase de test agregada: fuzzing de cambio de liga

Hasta ahora los tests de cambio de liga eran escenarios puntuales armados a
mano (A→B→A). Se agregó `test_fuzz_league_state.js`: genera una secuencia
LARGA y ALEATORIA (semilla fija, reproducible) de 200+ cambios de liga,
inyectando datos de aprendizaje distintos en cada salto, y verifica que el
estado de cada liga (learnedMarketStrength, learnedStrength, calibration)
coincida EXACTO con lo que se dejó la última vez que se la visitó -- sin
importar el orden ni la cantidad de saltos intermedios.

Esta clase de prueba (fuzzing/aleatoria en vez de escenarios fijos) es más
efectiva para encontrar bugs de estado en sistemas con múltiples "espacios"
independientes (acá: 5 ligas) que deben permanecer aislados entre sí --
justo la clase de bug que encontramos en `learnedMarketStrength`. Vale la
pena considerar este mismo enfoque si se agregan más propiedades
por-liga en el futuro, en vez de confiar solo en tests puntuales.

## NUEVA FUNCIONALIDAD: indicador de riesgo de empate (informativo, no correctivo)

Investigado a pedido del usuario si convenía "darle más peso al empate"
dado el patrón de 0% de aciertos en empates. Se descubrió con 146 partidos
reales que **pDraw ya está bien calibrado** (predicho 24.6% vs. real 24.7%,
y el rango 25-30% acertó 29% de las veces) -- el problema nunca fue la
probabilidad en sí, es que el empate casi nunca es la opción de mayor
probabilidad de las 3 (0/146 casos), lo cual es matemáticamente esperable
con 3 resultados posibles y ventaja de local. Forzar que el empate "gane"
más seguido habría empeorado la calibración real (Brier) para mejorar una
métrica que no es la que importa.

**En cambio, se agregó `drawRiskLevel(pDraw)`** -- un indicador puramente
informativo, verificado explícitamente con test (`test_draw_risk.js`,
bloque B) que confirma que NO altera ninguna probabilidad del modelo.
Umbrales basados en los datos reales medidos (no arbitrarios): <20% bajo,
20-27% normal (rango del promedio real), 27-32% alto, 32%+ muy alto.

Se muestra en el panel principal (siempre visible) y en el Top 10 por
confianza (solo cuando el riesgo es alto/muy alto, para no saturar la
lista con avisos irrelevantes en la mayoría de los partidos).

**Principio de diseño para recordar:** cuando una limitación del modelo
resulta ser un problema estructural conocido (no un bug), la respuesta
correcta es dar información honesta sobre esa limitación, no introducir
un sesgo para maquillar el síntoma.
