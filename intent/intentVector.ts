// intent/intentVector.ts
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
const MIN_DELTA_TIME = 1.0;
const MIN_DIVISOR = 1e-6;
const PERFECT_SCORE = 1.0;
const ZERO_SCORE = 0.0;

// ============================================================================
// Intent Vector Class
// ============================================================================

export class IntentVector {
  private config: IntentVectorConfig;

  private brownHolt: BrownHoltState = {
    s1x: 0,
    s1y: 0,
    s2x: 0,
    s2y: 0,
  };

  private motion: MotionState = {
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
  }

  setConfig(config: Partial<IntentVectorConfig>): void {
    this.config = { ...this.config, ...config };
  }

  reset(x: number, y: number): void {
    this.brownHolt = {
      s1x: x,
      s1y: y,
      s2x: x,
      s2y: y,
    };

    this.motion = {
      px: x,
      py: y,
      vx: 0,
      vy: 0,
      ax: 0,
      ay: 0,
      v2: 0,
    };
  }

  update(mx: number, my: number, dt: number): void {
    const safeDt = Math.max(dt, MIN_DELTA_TIME);
    const alpha = computeSmoothingFactor(safeDt, this.config);

    this.updateBrownHolt(mx, my, alpha);
    this.updateMotionState(safeDt, alpha);
  }

  hintVector(dx: number, dy: number, targetRadiusSq: number): number {
    const distanceSq = dx * dx + dy * dy;

    if (distanceSq < this.config.epsilon) {
      return PERFECT_SCORE;
    }

    const proximity = computeProximity(
      distanceSq,
      targetRadiusSq,
      this.config.epsilon,
    );

    // Low-speed near-target evidence
    if (this.motion.v2 < this.getMinSpeedSquared()) {
      return this.evaluateLowSpeedRegime(distanceSq, targetRadiusSq, proximity);
    }

    // High-speed motion-based evidence
    return this.evaluateHighSpeedRegime(
      dx,
      dy,
      distanceSq,
      targetRadiusSq,
      proximity,
    );
  }

  hintToPoint(tx: number, ty: number, targetRadiusSq: number): number {
    const dx = tx - this.motion.px;
    const dy = ty - this.motion.py;
    return this.hintVector(dx, dy, targetRadiusSq);
  }

  getKinematics(): Kinematics {
    return { ...this.motion };
  }

  // ========================================================================
  // Private - Brown-Holt Smoothing
  // ========================================================================

  private updateBrownHolt(mx: number, my: number, alpha: number): void {
    const inverseAlpha = 1.0 - alpha;

    const s1x = alpha * mx + inverseAlpha * this.brownHolt.s1x;
    const s1y = alpha * my + inverseAlpha * this.brownHolt.s1y;
    const s2x = alpha * s1x + inverseAlpha * this.brownHolt.s2x;
    const s2y = alpha * s1y + inverseAlpha * this.brownHolt.s2y;

    this.brownHolt = { s1x, s1y, s2x, s2y };
  }

  // ========================================================================
  // Private - Motion State Update
  // ========================================================================

  private updateMotionState(dt: number, alpha: number): void {
    const { s1x, s1y, s2x, s2y } = this.brownHolt;

    // Compute position (level)
    const px = BROWN_HOLT_LEVEL_FACTOR * s1x - s2x;
    const py = BROWN_HOLT_LEVEL_FACTOR * s1y - s2y;

    // Compute velocity (trend)
    const factor = alpha / Math.max(MIN_DIVISOR, 1.0 - alpha);
    const trendX = factor * (s1x - s2x);
    const trendY = factor * (s1y - s2y);

    const invDt = 1.0 / dt;
    let vx = trendX * invDt;
    let vy = trendY * invDt;

    // Clamp velocity to max
    const clamped = clampVelocity(vx, vy, this.config.vMax);
    vx = clamped.vx;
    vy = clamped.vy;

    // Compute acceleration
    const ax = (vx - this.motion.vx) * invDt;
    const ay = (vy - this.motion.vy) * invDt;
    const v2 = vx * vx + vy * vy;

    this.motion = { px, py, vx, vy, ax, ay, v2 };
  }

  // ========================================================================
  // Private - Low Speed Evaluation
  // ========================================================================

  private evaluateLowSpeedRegime(
    distanceSq: number,
    targetRadiusSq: number,
    proximity: number,
  ): number {
    // Inside target
    if (distanceSq <= targetRadiusSq) {
      return PERFECT_SCORE;
    }

    // Near target
    const nearMul = Math.max(1.0, this.config.lowSpeedNearMul);
    const nearRadiusSq = (nearMul * nearMul) * targetRadiusSq;

    if (distanceSq <= nearRadiusSq) {
      const scale = clamp(this.config.lowSpeedProxScale, 0.0, 1.0);
      return clamp(scale * proximity, 0.0, 1.0);
    }

    return ZERO_SCORE;
  }

  // ========================================================================
  // Private - High Speed Evaluation
  // ========================================================================

  private evaluateHighSpeedRegime(
    dx: number,
    dy: number,
    distanceSq: number,
    targetRadiusSq: number,
    proximity: number,
  ): number {
    const speed = Math.sqrt(this.motion.v2);

    // Dynamic horizon check
    if (!this.isWithinHorizon(distanceSq, targetRadiusSq, speed)) {
      return ZERO_SCORE;
    }

    // Direction alignment check
    const dotProduct = this.motion.vx * dx + this.motion.vy * dy;
    if (dotProduct <= 0) {
      return ZERO_SCORE;
    }

    // Cone gating
    if (!this.isWithinCone(distanceSq, targetRadiusSq, dotProduct, speed)) {
      return ZERO_SCORE;
    }

    // Compute alignment score
    const alignment = computeAlignment(
      dotProduct,
      this.motion.v2,
      distanceSq,
      this.config.epsilon,
    );

    // Compute brake evidence
    const brake = this.computeBrakeEvidence(speed, proximity);

    // Combine with proximity bias
    const proximityTerm = computeProximityTerm(
      proximity,
      this.config.proximityBias,
    );

    return Math.min(brake * alignment * proximityTerm, PERFECT_SCORE);
  }

  // ========================================================================
  // Private - Gating Checks
  // ========================================================================

  private isWithinHorizon(
    distanceSq: number,
    targetRadiusSq: number,
    speed: number,
  ): boolean {
    const horizon = this.config.horizonBasePx + speed * this.config.horizonMs;
    const horizonSq = horizon * horizon;
    return distanceSq <= targetRadiusSq || distanceSq <= horizonSq;
  }

  private isWithinCone(
    distanceSq: number,
    targetRadiusSq: number,
    dotProduct: number,
    speed: number,
  ): boolean {
    // Inside target radius passes automatically
    if (distanceSq <= targetRadiusSq) {
      return true;
    }

    const cosThetaSq = interpolateCosineSq(speed, this.config);
    const dotProductSq = dotProduct * dotProduct;

    return dotProductSq >= cosThetaSq * this.motion.v2 * distanceSq;
  }

  // ========================================================================
  // Private - Brake Evidence
  // ========================================================================

  private computeBrakeEvidence(speed: number, proximity: number): number {
    if (speed < this.config.vBrakeMin) {
      return this.config.brakeFloor;
    }

    const deceleration = this.computeDeceleration();
    if (deceleration <= 0) {
      return this.config.brakeFloor;
    }

    const boost = deceleration * Math.max(1.0, this.config.brakeTauMs) *
      proximity;

    return clamp(
      this.config.brakeFloor + boost,
      this.config.brakeFloor,
      this.config.brakeMax,
    );
  }

  private computeDeceleration(): number {
    const dotProduct = this.motion.vx * this.motion.ax +
      this.motion.vy * this.motion.ay;
    if (dotProduct >= 0) return 0;

    const minV2 = this.getMinSpeedSquared();
    const invV2 = 1.0 / Math.max(this.motion.v2, minV2);

    return -dotProduct * invV2;
  }

  // ========================================================================
  // Private - Helpers
  // ========================================================================

  private getMinSpeedSquared(): number {
    return this.config.vMin * this.config.vMin;
  }
}

// ============================================================================
// Smoothing Calculations
// ============================================================================

function computeSmoothingFactor(
  dt: number,
  config: IntentVectorConfig,
): number {
  const raw = 1.0 - Math.pow(
    1.0 - clamp(config.alphaRef, SMOOTHING_BOUNDS.MIN, SMOOTHING_BOUNDS.MAX),
    dt / Math.max(MIN_DIVISOR, config.dtRefMs),
  );

  return clamp(raw, SMOOTHING_BOUNDS.MIN, SMOOTHING_BOUNDS.MAX);
}

// ============================================================================
// Velocity Clamping
// ============================================================================

function clampVelocity(
  vx: number,
  vy: number,
  maxSpeed: number,
): { vx: number; vy: number } {
  const maxSpeedSq = maxSpeed * maxSpeed;
  const speedSq = vx * vx + vy * vy;

  if (speedSq <= maxSpeedSq) {
    return { vx, vy };
  }

  const scale = Math.sqrt(maxSpeedSq / Math.max(MIN_DIVISOR, speedSq));
  return {
    vx: vx * scale,
    vy: vy * scale,
  };
}

// ============================================================================
// Proximity Calculations
// ============================================================================

function computeProximity(
  distanceSq: number,
  targetRadiusSq: number,
  epsilon: number,
): number {
  return Math.min(targetRadiusSq / (distanceSq + epsilon), 1.0);
}

function computeProximityTerm(proximity: number, bias: number): number {
  const clampedBias = clamp(bias, 0.0, 1.0);
  return clampedBias + (1.0 - clampedBias) * proximity;
}

// ============================================================================
// Alignment Calculations
// ============================================================================

function computeAlignment(
  dotProduct: number,
  velocitySq: number,
  distanceSq: number,
  epsilon: number,
): number {
  const dotProductSq = dotProduct * dotProduct;
  return dotProductSq / (velocitySq * distanceSq + epsilon);
}

// ============================================================================
// Cone Interpolation
// ============================================================================

function interpolateCosineSq(
  speed: number,
  config: IntentVectorConfig,
): number {
  const t = clamp(
    (speed - config.vMin) / Math.max(MIN_DIVISOR, config.vTheta - config.vMin),
    0,
    1,
  );

  return lerp(config.cosThetaSqSlow, config.cosThetaSqFast, t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
