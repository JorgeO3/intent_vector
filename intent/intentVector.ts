import {
  clamp,
  MIN_DIVISOR,
  PERFECT_SCORE,
  ZERO_SCORE,
} from "../runtime/utils.ts";

// ============================================================================
// Type Definitions
// ============================================================================

export type IntentVectorConfig = {
  readonly alphaRef: number;
  readonly dtRefMs: number;
  readonly cosThetaSqSlow: number;
  readonly cosThetaSqFast: number;
  readonly vTheta: number;
  readonly epsilon: number;
  readonly vMin: number;
  readonly vMax: number;
  readonly brakeFloor: number;
  readonly brakeMax: number;
  readonly vBrakeMin: number;
  readonly brakeTauMs: number;
  readonly horizonBasePx: number;
  readonly horizonMs: number;
  readonly lowSpeedNearMul: number;
  readonly lowSpeedProxScale: number;
  readonly proximityBias: number;
};

export type Kinematics = {
  px: number;
  py: number;
  vx: number;
  vy: number;
  ax: number;
  ay: number;
  v2: number;
};

type DerivedConfig = {
  alphaRefClamped: number;
  oneMinusAlphaRef: number;
  vMinSq: number;
  vBrakeMinSq: number;
  maxSpeedSq: number;
  vThetaInvRange: number;
  bias: number;
  oneMinusBias: number;
  lowSpeedScale: number;
  nearMulSq: number;
  brakeTauMsClamped: number;
  epsilonInv: number;
  cosineSqDelta: number;
  dtRefInv: number;
  brakeRange: number;
};

// ============================================================================
// State Layout - Unified Memory Buffer
// ============================================================================

const enum StateIndex {
  // Brown-Holt Double Exponential Smoothing
  BROWN_S1X = 0,
  BROWN_S1Y = 1,
  BROWN_S2X = 2,
  BROWN_S2Y = 3,

  // Motion State (cinemática)
  POS_X = 4,
  POS_Y = 5,
  VEL_X = 6,
  VEL_Y = 7,
  ACC_X = 8,
  ACC_Y = 9,
  VEL_SQUARED = 10,

  // Alpha Caching
  CACHED_DT = 11,
  CACHED_ALPHA = 12,

  BUFFER_SIZE = 13,
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_FPS = 120;
const DEFAULT_DT_REF_MS = 1000 / DEFAULT_FPS;

const DEFAULT_CONFIG: IntentVectorConfig = {
  alphaRef: 0.55,
  dtRefMs: DEFAULT_DT_REF_MS,
  cosThetaSqSlow: 0.92,
  cosThetaSqFast: 0.70,
  vTheta: 0.35,
  epsilon: 1e-6,
  vMin: 0.02,
  vMax: 3.0,
  brakeFloor: 0.5,
  brakeMax: 2.0,
  vBrakeMin: 0.10,
  brakeTauMs: DEFAULT_DT_REF_MS,
  horizonBasePx: 80,
  horizonMs: 450,
  lowSpeedNearMul: 2.0,
  lowSpeedProxScale: 0.25,
  proximityBias: 0.30,
} as const;

const SMOOTHING_BOUNDS = {
  MIN: 1e-4,
  MAX: 0.9999,
} as const;

const BROWN_HOLT_LEVEL_FACTOR = 2.0;
const MIN_DELTA_TIME_MS = 1.0;

// ============================================================================
// Intent Vector Class - Extreme Performance Implementation
// ============================================================================

export class IntentVector {
  private config: IntentVectorConfig;
  private derived: DerivedConfig;

  // Unified state buffer - todo en memoria contigua
  private readonly state = new Float64Array(StateIndex.BUFFER_SIZE);

  // Frame-level cached values
  private speed = 0;
  private horizonSq = 0;
  private coneK = 0;
  private decelBoost = 0;

  // Kinematics cache (reutilizado, no se crea nuevo objeto cada vez)
  private readonly kinematicsCache: Kinematics = {
    px: 0,
    py: 0,
    vx: 0,
    vy: 0,
    ax: 0,
    ay: 0,
    v2: 0,
  };

  constructor(config?: Partial<IntentVectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.derived = this.computeDerivedConfig();
  }

  setConfig(config: Partial<IntentVectorConfig>): void {
    this.config = { ...this.config, ...config };
    this.derived = this.computeDerivedConfig();
  }

  reset(x: number, y: number): void {
    const s = this.state;

    // Reset Brown-Holt state
    s[StateIndex.BROWN_S1X] = x;
    s[StateIndex.BROWN_S1Y] = y;
    s[StateIndex.BROWN_S2X] = x;
    s[StateIndex.BROWN_S2Y] = y;

    // Reset motion state
    s[StateIndex.POS_X] = x;
    s[StateIndex.POS_Y] = y;
    s[StateIndex.VEL_X] = 0;
    s[StateIndex.VEL_Y] = 0;
    s[StateIndex.ACC_X] = 0;
    s[StateIndex.ACC_Y] = 0;
    s[StateIndex.VEL_SQUARED] = 0;

    // Reset caches
    s[StateIndex.CACHED_DT] = 0;
    s[StateIndex.CACHED_ALPHA] = 0;

    this.speed = 0;
    this.horizonSq = 0;
    this.coneK = 0;
    this.decelBoost = 0;
  }

  // ==========================================================================
  // CRITICAL HOT PATH: update() - Fully Inlined
  // ==========================================================================
  // OPTIMIZATION: Todo inlined para evitar function call overhead.
  // Accesos a 'this' minimizados - variables locales usan registros CPU.

  update(mx: number, my: number, dt: number): void {
    // Localización de referencias (critical para rendimiento)
    const s = this.state;
    const d = this.derived;
    const c = this.config;

    const safeDt = dt > MIN_DELTA_TIME_MS ? dt : MIN_DELTA_TIME_MS;

    // ---- Alpha Caching: evita Math.pow cuando dt no cambia ----
    let alpha = s[StateIndex.CACHED_ALPHA];
    if (safeDt !== s[StateIndex.CACHED_DT]) {
      alpha = 1.0 - Math.pow(d.oneMinusAlphaRef, safeDt * d.dtRefInv);
      // Inline clamp: más rápido que función
      if (alpha < SMOOTHING_BOUNDS.MIN) alpha = SMOOTHING_BOUNDS.MIN;
      else if (alpha > SMOOTHING_BOUNDS.MAX) alpha = SMOOTHING_BOUNDS.MAX;

      s[StateIndex.CACHED_DT] = safeDt;
      s[StateIndex.CACHED_ALPHA] = alpha;
    }

    const invAlpha = 1.0 - alpha;

    // ---- Brown-Holt Smoothing: inline para evitar call overhead ----
    const s1x = alpha * mx + invAlpha * s[StateIndex.BROWN_S1X];
    const s1y = alpha * my + invAlpha * s[StateIndex.BROWN_S1Y];
    const s2x = alpha * s1x + invAlpha * s[StateIndex.BROWN_S2X];
    const s2y = alpha * s1y + invAlpha * s[StateIndex.BROWN_S2Y];

    s[StateIndex.BROWN_S1X] = s1x;
    s[StateIndex.BROWN_S1Y] = s1y;
    s[StateIndex.BROWN_S2X] = s2x;
    s[StateIndex.BROWN_S2Y] = s2y;

    // ---- Motion State Update: inline para máximo rendimiento ----

    // Position: extrapolación de nivel (2*S1 - S2)
    const px = BROWN_HOLT_LEVEL_FACTOR * s1x - s2x;
    const py = BROWN_HOLT_LEVEL_FACTOR * s1y - s2y;

    // Velocity: derivada del trend escalada por tiempo
    const trendFactor = alpha /
      (invAlpha > MIN_DIVISOR ? invAlpha : MIN_DIVISOR);
    const invDt = 1.0 / safeDt;

    let vx = trendFactor * (s1x - s2x) * invDt;
    let vy = trendFactor * (s1y - s2y) * invDt;

    // Clamp velocity a vMax
    const speedSq = vx * vx + vy * vy;
    if (speedSq > d.maxSpeedSq) {
      const scale = c.vMax / Math.sqrt(speedSq);
      vx *= scale;
      vy *= scale;
    }

    const v2 = vx * vx + vy * vy;

    // Acceleration: diferencia finita de velocidad
    const ax = (vx - s[StateIndex.VEL_X]) * invDt;
    const ay = (vy - s[StateIndex.VEL_Y]) * invDt;

    // Write back al buffer unificado
    s[StateIndex.POS_X] = px;
    s[StateIndex.POS_Y] = py;
    s[StateIndex.VEL_X] = vx;
    s[StateIndex.VEL_Y] = vy;
    s[StateIndex.ACC_X] = ax;
    s[StateIndex.ACC_Y] = ay;
    s[StateIndex.VEL_SQUARED] = v2;

    // ---- Frame Cache: inline para evitar call overhead ----

    const speed = Math.sqrt(v2);
    this.speed = speed;

    const horizon = c.horizonBasePx + speed * c.horizonMs;
    this.horizonSq = horizon * horizon;

    // Interpolate cone K (inline clamp con ternarios)
    let t = (speed - c.vMin) * d.vThetaInvRange;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);

    const cosThetaSq = c.cosThetaSqSlow + d.cosineSqDelta * t;
    this.coneK = cosThetaSq * v2;

    // Braking boost (inline para evitar call overhead)
    if (v2 >= d.vBrakeMinSq) {
      const dotVA = vx * ax + vy * ay;
      if (dotVA < 0) {
        const invV2 = 1.0 / (v2 > d.vMinSq ? v2 : d.vMinSq);
        this.decelBoost = (-dotVA * invV2) * d.brakeTauMsClamped;
      } else {
        this.decelBoost = 0;
      }
    } else {
      this.decelBoost = 0;
    }
  }

  // ==========================================================================
  // CRITICAL HOT PATH: hintVector() - Fully Inlined
  // ==========================================================================

  hintVector(dx: number, dy: number, targetRadiusSq: number): number {
    const distSq = dx * dx + dy * dy;
    const s = this.state;
    const c = this.config;
    const d = this.derived;
    const v2 = s[StateIndex.VEL_SQUARED];

    // Early exit: punto de contacto exacto
    if (distSq < c.epsilon) {
      return PERFECT_SCORE;
    }

    // ---- Régimen de baja velocidad: usa proximity scoring ----
    if (v2 < d.vMinSq) {
      // Dentro del target: score perfecto
      if (distSq <= targetRadiusSq) {
        return PERFECT_SCORE;
      }

      // Fuera del rango "near": score cero
      const nearThresholdSq = d.nearMulSq * targetRadiusSq;
      if (distSq > nearThresholdSq) {
        return ZERO_SCORE;
      }

      // Proximity falloff (inline, sin llamadas)
      const proximity = targetRadiusSq / (distSq + c.epsilon);
      const prox = proximity > 1 ? 1 : proximity;
      const score = d.lowSpeedScale * prox;

      return score <= 0 ? ZERO_SCORE : (score >= 1 ? PERFECT_SCORE : score);
    }

    // ---- Régimen de alta velocidad: gates baratos primero ----

    // Gate 1: distancia más allá del horizonte
    if (distSq > targetRadiusSq && distSq > this.horizonSq) {
      return ZERO_SCORE;
    }

    const vx = s[StateIndex.VEL_X];
    const vy = s[StateIndex.VEL_Y];
    const dot = vx * dx + vy * dy;

    // Gate 2: movimiento hacia atrás
    if (dot <= 0) {
      return ZERO_SCORE;
    }

    // Gate 3: fuera del cono de movimiento
    const dotSq = dot * dot;
    if (distSq > targetRadiusSq && dotSq < this.coneK * distSq) {
      return ZERO_SCORE;
    }

    // ---- Score completo: inline todas las operaciones ----

    // Proximity: qué tan cerca estamos del target
    const proximity = targetRadiusSq / (distSq + c.epsilon);
    const prox = proximity > 1 ? 1 : proximity;

    // Alignment: qué tan alineado está el movimiento
    let alignment = dotSq / (v2 * distSq + c.epsilon);
    if (alignment > 1) alignment = 1;

    // Brake evidence: boost si estamos desacelerando hacia el target
    let brake = c.brakeFloor;
    if (this.decelBoost > 0 && v2 >= d.vBrakeMinSq) {
      brake = c.brakeFloor + this.decelBoost * prox;
      // Inline clamp
      if (brake > c.brakeMax) brake = c.brakeMax;
      else if (brake < c.brakeFloor) brake = c.brakeFloor;
    }

    // Proximity term: interpolación biased
    const proxTerm = d.bias + d.oneMinusBias * prox;

    // Score final
    const score = brake * alignment * proxTerm;
    return score > 1 ? 1 : (score <= 0 ? 0 : score);
  }

  hintToPoint(tx: number, ty: number, targetRadiusSq: number): number {
    const s = this.state;
    return this.hintVector(
      tx - s[StateIndex.POS_X],
      ty - s[StateIndex.POS_Y],
      targetRadiusSq,
    );
  }

  getKinematics(): Kinematics {
    const s = this.state;
    const k = this.kinematicsCache;

    k.px = s[StateIndex.POS_X];
    k.py = s[StateIndex.POS_Y];
    k.vx = s[StateIndex.VEL_X];
    k.vy = s[StateIndex.VEL_Y];
    k.ax = s[StateIndex.ACC_X];
    k.ay = s[StateIndex.ACC_Y];
    k.v2 = s[StateIndex.VEL_SQUARED];

    return k;
  }

  // ==========================================================================
  // Private - Configuration (no es hot path)
  // ==========================================================================

  private computeDerivedConfig(): DerivedConfig {
    const c = this.config;

    const alphaRefClamped = clamp(
      c.alphaRef,
      SMOOTHING_BOUNDS.MIN,
      SMOOTHING_BOUNDS.MAX,
    );

    const vThetaRange = c.vTheta - c.vMin;
    const vThetaInvRange = 1.0 /
      (vThetaRange > MIN_DIVISOR ? vThetaRange : MIN_DIVISOR);

    const bias = clamp(c.proximityBias, 0.0, 1.0);

    const nearMul = c.lowSpeedNearMul > 1.0 ? c.lowSpeedNearMul : 1.0;

    const brakeTauMsClamped = c.brakeTauMs > 1.0 ? c.brakeTauMs : 1.0;

    return {
      alphaRefClamped,
      oneMinusAlphaRef: 1.0 - alphaRefClamped,
      vMinSq: c.vMin * c.vMin,
      vBrakeMinSq: c.vBrakeMin * c.vBrakeMin,
      maxSpeedSq: c.vMax * c.vMax,
      vThetaInvRange,
      bias,
      oneMinusBias: 1.0 - bias,
      lowSpeedScale: clamp(c.lowSpeedProxScale, 0.0, 1.0),
      nearMulSq: nearMul * nearMul,
      brakeTauMsClamped,
      epsilonInv: 1.0 / c.epsilon,
      cosineSqDelta: c.cosThetaSqFast - c.cosThetaSqSlow,
      dtRefInv: 1.0 / (c.dtRefMs > MIN_DIVISOR ? c.dtRefMs : MIN_DIVISOR),
      brakeRange: c.brakeMax - c.brakeFloor,
    };
  }
}
