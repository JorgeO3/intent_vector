# Profiling de IntentVector

Este directorio contiene herramientas para profiling y análisis de rendimiento.

## ⚠️ Importante

El **profiling está DESHABILITADO por defecto** en el código de producción
porque tiene un overhead masivo (~27,000%). IntentVector.update() es
extremadamente rápido (~0.03 μs/call) y el overhead de medición es mucho mayor
que el código mismo.

## Archivos de Profiling

### `profiler.ts`

Sistema de profiling con timers de bajo nivel. **No usar en producción**.

### `main.ts` - Profiling con overhead

Stress test con profiling detallado de cada sección de `update()`.

**Características:**

- Mide tiempo de cada sección (Alpha Cache, Brown-Holt, etc.)
- Overhead: ~27,000% (16.67 μs vs 0.06 μs)
- Útil para identificar hotspots relativos

**Uso:**

```bash
deno run main.ts
```

### `stress.ts` - Rendimiento Puro

Medición de rendimiento sin overhead de profiling.

**Características:**

- 1 millón de iteraciones
- ~0.06 μs por llamada
- 16.7 millones de llamadas/segundo
- 0.00% del budget de 60fps

**Uso:**

```bash
deno run stress.ts
```

### `stress-realistic.ts` - Escenario Real

Test con update() + evaluación de múltiples targets.

**Características:**

- 10,000 frames simulados
- 20 targets por frame
- Mide tiempo de update() vs scoring
- Muestra escalabilidad con diferentes cantidades de targets

**Uso:**

```bash
deno run stress-realistic.ts
```

## Resultados Típicos

### Sin Profiling (Producción)

```
update() single call: 1.3 ms / 50k ops = 0.026 μs/call
hintToPoint() 50k calls: 229 μs = 0.005 μs/call
```

### Con 20 Targets por Frame

```
Frame time: 0.006 ms
FPS budget usado: 0.04%
update(): 23.9% del tiempo
scoring: 34.6% del tiempo
```

### Escalabilidad

| Targets | Frame Time | FPS Budget |
| ------- | ---------- | ---------- |
| 10      | 0.001 ms   | 0.00%      |
| 20      | 0.001 ms   | 0.01%      |
| 50      | 0.002 ms   | 0.01%      |
| 100     | 0.004 ms   | 0.03%      |
| 200     | 0.004 ms   | 0.03%      |

## Conclusiones

**IntentVector es EXTREMADAMENTE eficiente:**

- Puede procesar millones de updates por segundo
- Con 200 targets evaluados por frame, solo usa 0.03% del budget de 60fps
- No hay hotspots - todo está optimizado
- El profiling tiene más overhead que el código mismo

**No necesitas optimizar IntentVector.update() - ya es óptimo.**
