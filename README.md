# Intent Vector

Biblioteca de predicción de intención basada en movimiento del cursor para
pre-carga inteligente de componentes UI.

## 📦 Instalación

```ts
// Deno / JSR
import { IntentVector, TargetLock } from "jsr:@intent/vector";

// Core bundle (3 KB brotli)
import { IntentVector, TargetLock } from "jsr:@intent/vector/core";

// Standard bundle (4.5 KB brotli)
import {
  IntentVector,
  IslandLocator,
  TargetLock,
} from "jsr:@intent/vector/standard";
```

## 🎯 Uso Rápido

```ts
import { IntentVector, TargetLock } from "@intent/vector/core";

// Crear vector de intención
const iv = new IntentVector();

// En cada frame (requestAnimationFrame)
function onMouseMove(event: MouseEvent, dt: number) {
  iv.update(event.clientX, event.clientY, dt);
}

// Evaluar targets
const score = iv.hintToPoint(targetX, targetY, targetDistance);
if (score > 0.8) {
  // Alta probabilidad de que el usuario se dirige a este target
  prefetchComponent();
}
```

## 📊 Bundles Disponibles

| Bundle     | Tamaño (Brotli) | Incluye                               |
| ---------- | --------------- | ------------------------------------- |
| `core`     | ~3 KB           | IntentVector, TargetLock              |
| `standard` | ~4.5 KB         | Core + IslandLocator                  |
| Full       | ~11 KB          | Todo (Runtime, FlightScheduler, etc.) |

## 🛠️ Desarrollo

```bash
# Tests
deno task test

# Benchmarks
deno task bench

# Build producción
deno task build

# Ver tamaño de bundle
deno task build:check
```

## 📁 Estructura

```
mod.ts           # Entry point completo
mod.core.ts      # Entry point minimal (< 5 KB)
mod.standard.ts  # Entry point standard (< 7 KB)

intent/
  intentVector.ts   # Predicción de movimiento Brown-Holt

runtime/
  targetLock.ts     # Lock de target con histéresis
  islandLocator.ts  # Escaneo de DOM para islands
  flightScheduler.ts
  ...
```

## 📈 API Principal

### `IntentVector`

```ts
const iv = new IntentVector(config?);
iv.update(x, y, dt);                    // Actualizar con posición y delta tiempo
iv.hintToPoint(tx, ty, dist): number;   // Score [0,1] hacia un punto
iv.hintVector(dx, dy, dist): number;    // Score hacia un vector delta
iv.getKinematics(): Kinematics;         // Estado actual (vx, vy, speed, etc.)
iv.reset(x?, y?);                       // Resetear estado
```

### `TargetLock`

```ts
const tl = new TargetLock(intentVector, config?);
tl.tick(candidates, dt);               // Procesar candidatos
tl.getWinnerKey(): IslandKey | null;   // Target actual con lock
tl.getPendingKey(): IslandKey | null;  // Target en proceso de lock
```

### `IslandLocator`

```ts
const locator = new IslandLocator(config?);
locator.scan(document.body);           // Escanear DOM
locator.candidates(ix, iy): Handle[];  // Candidatos cerca de posición
locator.getHandle(key): Handle | undefined;
```

## 📄 Licencia

MIT
