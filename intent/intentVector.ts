import { clamp } from "../runtime/targetLock.ts";

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
  readonly px: number;
  readonly py: number;
  readonly vx: number;
  readonly vy: number;
  readonly ax: number;
  readonly ay: number;
  readonly v2: number;
};

type BrownHoltState = {
  s1x: number;
  s1y: number;
  s2x: number;
  s2y: number;
};

type MotionState = {
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
  // NUEVO: Pre-calcular más valores
  epsilonInv: number;
  cosineSqDelta: number; // cosThetaSqFast - cosThetaSqSlow
  dtRefInv: number;
  brakeRange: number; // brakeMax - brakeFloor
};

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
const MAX_REASONABLE_DT_MS = 1000;
const MIN_DIVISOR = 1e-6;
const PERFECT_SCORE = 1.0;
const ZERO_SCORE = 0.0;

// ============================================================================
// Intent Vector Class - OPTIMIZADO
// ============================================================================

export class IntentVector {
  private config: IntentVectorConfig;
  private d: DerivedConfig;
  private brownHolt: BrownHoltState = { s1x: 0, s1y: 0, s2x: 0, s2y: 0 };
  private motion: MotionState = {
    px: 0,
    py: 0,
    vx: 0,
    vy: 0,
    ax: 0,
    ay: 0,
    v2: 0,
  };

  // Cache por frame
  private speed = 0;
  private horizonSq = 0;
  private coneK = 0;
  private decelBoost = 0;

  private readonly kinematicsCache: {
    px: number;
    py: number;
    vx: number;
    vy: number;
    ax: number;
    ay: number;
    v2: number;
  } = { px: 0, py: 0, vx: 0, vy: 0, ax: 0, ay: 0, v2: 0 };

  private warnedDt = false;

  constructor(config?: Partial<IntentVectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.d = computeDerived(this.config);
  }

  setConfig(config: Partial<IntentVectorConfig>): void {
    this.config = { ...this.config, ...config };
    this.d = computeDerived(this.config);
  }

  reset(x: number, y: number): void {
    this.brownHolt.s1x = x;
    this.brownHolt.s1y = y;
    this.brownHolt.s2x = x;
    this.brownHolt.s2y = y;
    this.motion.px = x;
    this.motion.py = y;
    this.motion.vx = 0;
    this.motion.vy = 0;
    this.motion.ax = 0;
    this.motion.ay = 0;
    this.motion.v2 = 0;
    this.speed = 0;
    this.horizonSq = 0;
    this.coneK = 0;
    this.decelBoost = 0;
    this.warnedDt = false;
  }

  update(mx: number, my: number, dt: number): void {
    if (!this.warnedDt && (dt < 0.5 || dt > MAX_REASONABLE_DT_MS)) {
      this.warnedDt = true;
      console.warn(
        "[IntentVector] dt fuera de rango. ¿Seguro que dt está en ms?",
        { dt },
      );
    }

    const safeDt = dt > MIN_DELTA_TIME_MS ? dt : MIN_DELTA_TIME_MS;
    const alpha = computeSmoothingFactorFast(safeDt, this.d);

    this.updateBrownHolt(mx, my, alpha);
    this.updateMotionStateFast(safeDt, alpha);
  }

  hintVector(dx: number, dy: number, targetRadiusSq: number): number {
    const distSq = dx * dx + dy * dy;

    // Early exit: punto de contacto
    if (distSq < this.config.epsilon) return PERFECT_SCORE;

    // Régimen de baja velocidad
    if (this.motion.v2 < this.d.vMinSq) {
      if (distSq <= targetRadiusSq) return PERFECT_SCORE;

      // OPTIMIZACIÓN: Evitar multiplicación si está fuera del rango cercano
      const nearThresholdSq = this.d.nearMulSq * targetRadiusSq;
      if (distSq > nearThresholdSq) return ZERO_SCORE;

      // OPTIMIZACIÓN: Proximity inline y simplificado
      const proximity = targetRadiusSq / (distSq + this.config.epsilon);
      const prox = proximity > 1 ? 1 : proximity;
      const s = this.d.lowSpeedScale * prox;

      return s <= 0 ? ZERO_SCORE : (s >= 1 ? PERFECT_SCORE : s);
    }

    // Régimen de alta velocidad: gates baratos primero
    if (distSq > targetRadiusSq && distSq > this.horizonSq) return ZERO_SCORE;

    const dot = this.motion.vx * dx + this.motion.vy * dy;
    if (dot <= 0) return ZERO_SCORE;

    // Cone gating (optimizado: dot² pre-calculado una sola vez)
    const dotSq = dot * dot;
    if (distSq > targetRadiusSq && dotSq < this.coneK * distSq) {
      return ZERO_SCORE;
    }

    // OPTIMIZACIÓN: Proximity inline
    const proximity = targetRadiusSq / (distSq + this.config.epsilon);
    const prox = proximity > 1 ? 1 : proximity;

    // OPTIMIZACIÓN: Alignment inline (división única)
    let alignment = dotSq / (this.motion.v2 * distSq + this.config.epsilon);
    if (alignment > 1) alignment = 1;

    // OPTIMIZACIÓN: Brake evidence simplificado
    let brake = this.config.brakeFloor;
    if (this.decelBoost > 0 && this.motion.v2 >= this.d.vBrakeMinSq) {
      brake = this.config.brakeFloor + this.decelBoost * prox;
      // Clamp manual más rápido que Math.min/max
      if (brake > this.config.brakeMax) brake = this.config.brakeMax;
      else if (brake < this.config.brakeFloor) brake = this.config.brakeFloor;
    }

    // OPTIMIZACIÓN: Proximity term inline
    const proxTerm = this.d.bias + this.d.oneMinusBias * prox;

    const score = brake * alignment * proxTerm;
    return score > 1 ? 1 : (score <= 0 ? 0 : score);
  }

  hintToPoint(tx: number, ty: number, targetRadiusSq: number): number {
    // Inline para evitar call overhead
    return this.hintVector(
      tx - this.motion.px,
      ty - this.motion.py,
      targetRadiusSq,
    );
  }

  getKinematics(): Kinematics {
    const k = this.kinematicsCache;
    k.px = this.motion.px;
    k.py = this.motion.py;
    k.vx = this.motion.vx;
    k.vy = this.motion.vy;
    k.ax = this.motion.ax;
    k.ay = this.motion.ay;
    k.v2 = this.motion.v2;
    return k;
  }

  // ========================================================================
  // Private - Brown-Holt (sin cambios, ya es óptimo)
  // ========================================================================

  private updateBrownHolt(mx: number, my: number, alpha: number): void {
    const inv = 1.0 - alpha;
    const s1x = alpha * mx + inv * this.brownHolt.s1x;
    const s1y = alpha * my + inv * this.brownHolt.s1y;
    const s2x = alpha * s1x + inv * this.brownHolt.s2x;
    const s2y = alpha * s1y + inv * this.brownHolt.s2y;
    this.brownHolt.s1x = s1x;
    this.brownHolt.s1y = s1y;
    this.brownHolt.s2x = s2x;
    this.brownHolt.s2y = s2y;
  }

  // ========================================================================
  // Private - Motion State Update OPTIMIZADO
  // ========================================================================

  private updateMotionStateFast(dt: number, alpha: number): void {
    const { s1x, s1y, s2x, s2y } = this.brownHolt;

    // Position (level)
    const px = BROWN_HOLT_LEVEL_FACTOR * s1x - s2x;
    const py = BROWN_HOLT_LEVEL_FACTOR * s1y - s2y;

    // Velocity (trend)
    const oneMinusAlpha = 1.0 - alpha;
    const factor = alpha /
      (oneMinusAlpha > MIN_DIVISOR ? oneMinusAlpha : MIN_DIVISOR);
    const trendX = factor * (s1x - s2x);
    const trendY = factor * (s1y - s2y);

    const invDt = 1.0 / dt;
    let vx = trendX * invDt;
    let vy = trendY * invDt;

    // Clamp velocity (optimizado: sqrt solo cuando necesario)
    const speedSq = vx * vx + vy * vy;
    if (speedSq > this.d.maxSpeedSq) {
      const scale = this.config.vMax / Math.sqrt(speedSq);
      vx *= scale;
      vy *= scale;
    }

    // Acceleration
    const ax = (vx - this.motion.vx) * invDt;
    const ay = (vy - this.motion.vy) * invDt;
    const v2 = vx * vx + vy * vy;

    // Write motion state
    this.motion.px = px;
    this.motion.py = py;
    this.motion.vx = vx;
    this.motion.vy = vy;
    this.motion.ax = ax;
    this.motion.ay = ay;
    this.motion.v2 = v2;

    // ---- Caches por frame ----
    this.speed = Math.sqrt(v2);
    const horizon = this.config.horizonBasePx +
      this.speed * this.config.horizonMs;
    this.horizonSq = horizon * horizon;

    // OPTIMIZACIÓN: interpolateCosineSq inline
    const t = clamp(
      (this.speed - this.config.vMin) * this.d.vThetaInvRange,
      0,
      1,
    );
    const cosThetaSq = this.config.cosThetaSqSlow + this.d.cosineSqDelta * t;
    this.coneK = cosThetaSq * v2;

    // Braking boost pre-calculado
    this.decelBoost = 0;
    if (v2 >= this.d.vBrakeMinSq) {
      const dotVA = vx * ax + vy * ay;
      if (dotVA < 0) {
        const invV2 = 1.0 / (v2 > this.d.vMinSq ? v2 : this.d.vMinSq);
        const decel = -dotVA * invV2;
        this.decelBoost = decel * this.d.brakeTauMsClamped;
      }
    }
  }
}

// ============================================================================
// Helpers OPTIMIZADOS
// ============================================================================

function computeDerived(config: IntentVectorConfig): DerivedConfig {
  const alphaRefClamped = clamp(
    config.alphaRef,
    SMOOTHING_BOUNDS.MIN,
    SMOOTHING_BOUNDS.MAX,
  );
  const vMinSq = config.vMin * config.vMin;
  const vBrakeMinSq = config.vBrakeMin * config.vBrakeMin;
  const maxSpeedSq = config.vMax * config.vMax;
  const vThetaRange = config.vTheta - config.vMin;
  const vThetaInvRange = 1.0 /
    (vThetaRange > MIN_DIVISOR ? vThetaRange : MIN_DIVISOR);
  const bias = clamp(config.proximityBias, 0.0, 1.0);
  const oneMinusBias = 1.0 - bias;
  const lowSpeedScale = clamp(config.lowSpeedProxScale, 0.0, 1.0);
  const nearMul = config.lowSpeedNearMul > 1.0 ? config.lowSpeedNearMul : 1.0;
  const nearMulSq = nearMul * nearMul;
  const brakeTauMsClamped = config.brakeTauMs > 1.0 ? config.brakeTauMs : 1.0;

  // NUEVO: Pre-calcular más valores
  const epsilonInv = 1.0 / config.epsilon;
  const cosineSqDelta = config.cosThetaSqFast - config.cosThetaSqSlow;
  const dtRefInv = 1.0 /
    (config.dtRefMs > MIN_DIVISOR ? config.dtRefMs : MIN_DIVISOR);
  const brakeRange = config.brakeMax - config.brakeFloor;

  return {
    alphaRefClamped,
    oneMinusAlphaRef: 1.0 - alphaRefClamped,
    vMinSq,
    vBrakeMinSq,
    maxSpeedSq,
    vThetaInvRange,
    bias,
    oneMinusBias,
    lowSpeedScale,
    nearMulSq,
    brakeTauMsClamped,
    epsilonInv,
    cosineSqDelta,
    dtRefInv,
    brakeRange,
  };
}

// OPTIMIZACIÓN: Smoothing factor inline-friendly
function computeSmoothingFactorFast(dt: number, d: DerivedConfig): number {
  const raw = 1.0 - Math.pow(d.oneMinusAlphaRef, dt * d.dtRefInv);
  return clamp(raw, SMOOTHING_BOUNDS.MIN, SMOOTHING_BOUNDS.MAX);
}
