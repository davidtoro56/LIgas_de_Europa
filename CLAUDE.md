
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
