import type { IntentVector } from "../intent/intentVector.ts";
import type {
  Candidate,
  IslandKey,
  Rect,
  ScoredTarget,
  Selection,
} from "./types.ts";
import { clamp, NO_SCORE, ZERO_SCORE } from "./utils.ts";

// ============================================================================
// Type Definitions
// ============================================================================

export type TargetLockConfig = {
  readonly topK: number;
  readonly scoreFloor: number;
  readonly minMargin2nd: number;
  readonly switchMargin: number;
  readonly holdFrames: number;
  readonly decay: number;
  readonly noEvidenceHoldMs: number;
  readonly clearAfterMs: number;
  readonly stickDistPx: number;
  readonly radiusMul: number;
  readonly reportTopN: number;
};

type CandidateWithDistance = {
  readonly key: IslandKey;
  readonly rect: Rect;
  readonly d2: number;
  readonly dx: number;
  readonly dy: number;
};

type ScoringResult = {
  readonly scored: ScoredTarget[];
  readonly bestKey: IslandKey | null;
  readonly bestScore: number;
  readonly secondScore: number;
  readonly currentWinnerScore: number;
};

type NearestCandidate = {
  readonly key: IslandKey | null;
  readonly d2: number;
};

type DerivedConfig = {
  readonly topK: number;
  readonly reportTopN: number;
  readonly stickDistSq: number;
  readonly radiusMulSq: number;
  readonly holdFrames: number;
};

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CONFIG: TargetLockConfig = {
  topK: 10,
  scoreFloor: 0.02,
  minMargin2nd: 0.04,
  switchMargin: 0.08,
  holdFrames: 3,
  decay: 0.85,
  noEvidenceHoldMs: 120,
  clearAfterMs: 350,
  stickDistPx: 140,
  radiusMul: 0.35,
  reportTopN: 5,
} as const;

const DEFAULT_FPS = 60;
const DEFAULT_FRAME_TIME_MS = 1000 / DEFAULT_FPS;

const INFINITE_DISTANCE = Infinity;

// ============================================================================
// Target Lock Class
// ============================================================================

export class TargetLock {
  private readonly core: IntentVector;
  private config: TargetLockConfig;
  private derived: DerivedConfig;

  // Winner state
  private winnerKey: IslandKey | null = null;
  private winnerScore = ZERO_SCORE;

  // Pending switch state (dwell time)
  private pendingKey: IslandKey | null = null;
  private pendingCount = 0;

  // No-evidence tracking
  private noEvidenceTimeMs = 0;

  // Reusable buffers to minimize allocations (hot path optimization)
  private readonly topKBuffer: CandidateWithDistance[] = [];
  private readonly scoredBuffer: ScoredTarget[] = [];

  // Object pool for ScoredTarget (avoids GC pressure in hot path)
  private readonly scoredPool: ScoredTarget[] = [];
  private poolIdx = 0;
  private static readonly POOL_SIZE = 32;

  constructor(core: IntentVector, config?: Partial<TargetLockConfig>) {
    this.core = core;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.derived = computeDerived(this.config);
    // Pre-allocate object pool
    for (let i = 0; i < TargetLock.POOL_SIZE; i++) {
      this.scoredPool.push({ key: 0 as IslandKey, score: 0, d2: 0 });
    }
  }

  setConfig(config: Partial<TargetLockConfig>): void {
    this.config = { ...this.config, ...config };
    this.derived = computeDerived(this.config);
  }

  reset(): void {
    this.winnerKey = null;
    this.winnerScore = ZERO_SCORE;
    this.pendingKey = null;
    this.pendingCount = 0;
    this.noEvidenceTimeMs = 0;
  }

  /**
   * Main selection algorithm.
   * Evaluates candidates and returns current selection state.
   */
  select(
    candidates: Candidate[],
    deltaTimeMs = DEFAULT_FRAME_TIME_MS,
  ): Selection {
    const kinematics = this.core.getKinematics();
    const speed = kinematics.v2 > 0 ? Math.sqrt(kinematics.v2) : 0;

    // Build top-K + nearest in one pass (reuses buffers)
    const nearest = this.buildTopKAndNearest(
      candidates,
      kinematics.px,
      kinematics.py,
    );

    // Score candidates (reuses scoredBuffer)
    const scoring = this.scoreCandidates();

    const margin2nd = scoring.bestScore - scoring.secondScore;
    const hasEvidence = scoring.bestKey !== null &&
      scoring.bestScore >= this.config.scoreFloor;

    // Update winner score (correctness: no double-decay)
    this.updateWinnerScore(hasEvidence, scoring.currentWinnerScore);

    // Prepare output targets
    const top = this.prepareOutputTargets();

    // Handle no-evidence regime
    if (!hasEvidence) {
      return this.handleNoEvidence(
        deltaTimeMs,
        nearest,
        scoring,
        margin2nd,
        speed,
        top,
      );
    }

    // Evidence restored
    this.noEvidenceTimeMs = 0;

    // Determine selection
    return this.determineSelection(scoring, margin2nd, nearest, speed, top);
  }

  // ========================================================================
  // Private - Candidate Processing (HOT PATH)
  // ========================================================================

  /**
   * Builds top-K candidates and finds nearest in a single pass.
   * OPTIMIZATION: Reuses topKBuffer to avoid allocations.
   */
  private buildTopKAndNearest(
    candidates: Candidate[],
    px: number,
    py: number,
  ): NearestCandidate {
    const buffer = this.topKBuffer;
    buffer.length = 0; // Clear without allocating

    const k = this.derived.topK;
    let nearestKey: IslandKey | null = null;
    let nearestD2 = INFINITE_DISTANCE;

    let winnerDistance: CandidateWithDistance | null = null;
    let winnerInTopK = false;

    // Single pass: compute distances, track nearest, build top-K
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const dist = this.computeCandidateDistance(candidate, px, py);

      // Track nearest
      if (dist.d2 < nearestD2) {
        nearestD2 = dist.d2;
        nearestKey = dist.key;
      }

      // Track winner if present
      if (this.winnerKey !== null && dist.key === this.winnerKey) {
        winnerDistance = dist;
        winnerInTopK = false; // Will check after insertion
      }

      // Insert into top-K
      this.insertSortedByDistance(dist, k);

      // Check if winner is now in top-K
      if (winnerDistance && !winnerInTopK) {
        for (let j = 0; j < buffer.length; j++) {
          if (buffer[j].key === this.winnerKey) {
            winnerInTopK = true;
            break;
          }
        }
      }
    }

    // Force-include winner if not in top-K
    if (winnerDistance && !winnerInTopK) {
      this.insertSortedByDistance(winnerDistance, k);
    }

    return { key: nearestKey, d2: nearestD2 };
  }

  /**
   * OPTIMIZATION: Inline distance calculation with manual clamp.
   */
  private computeCandidateDistance(
    candidate: Candidate,
    px: number,
    py: number,
  ): CandidateWithDistance {
    const r = candidate.rect;
    const rx2 = r.x + r.w;
    const ry2 = r.y + r.h;

    // Inline clamp (faster than function call)
    const cx = px < r.x ? r.x : px > rx2 ? rx2 : px;
    const cy = py < r.y ? r.y : py > ry2 ? ry2 : py;

    const dx = cx - px;
    const dy = cy - py;
    const d2 = dx * dx + dy * dy;

    return { key: candidate.key, rect: r, d2, dx, dy };
  }

  /**
   * OPTIMIZATION: Binary search insertion for better performance with larger K.
   */
  private insertSortedByDistance(
    item: CandidateWithDistance,
    maxSize: number,
  ): void {
    const buffer = this.topKBuffer;

    // Early exit: buffer full and item is farther than worst
    if (buffer.length === maxSize && item.d2 >= buffer[maxSize - 1].d2) {
      return;
    }

    // Binary search for insertion point
    let left = 0;
    let right = buffer.length;

    while (left < right) {
      const mid = (left + right) >>> 1; // Fast integer division
      if (buffer[mid].d2 <= item.d2) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }

    buffer.splice(left, 0, item);

    // Maintain max size
    if (buffer.length > maxSize) {
      buffer.length = maxSize;
    }
  }

  // ========================================================================
  // Private - Scoring (HOT PATH)
  // ========================================================================

  /**
   * OPTIMIZATION: Reuses scoredBuffer and object pool to avoid allocations.
   */
  private scoreCandidates(): ScoringResult {
    let bestKey: IslandKey | null = null;
    let bestScore = NO_SCORE;
    let secondScore = NO_SCORE;
    let currentWinnerScore = NO_SCORE;

    const scoredBuffer = this.scoredBuffer;
    scoredBuffer.length = 0; // Clear without allocating
    this.poolIdx = 0; // Reset pool index

    const buffer = this.topKBuffer;

    for (let i = 0; i < buffer.length; i++) {
      const c = buffer[i];
      const score = this.scoreCandidate(c);

      // Track current winner score
      if (this.winnerKey !== null && c.key === this.winnerKey) {
        currentWinnerScore = score;
      }

      // Track best and second-best
      if (score > bestScore) {
        secondScore = bestScore;
        bestScore = score;
        bestKey = c.key;
      } else if (score > secondScore) {
        secondScore = score;
      }

      // Use pooled object instead of creating new one
      const pooled = this.acquirePooledScored(c.key, score, c.d2);
      scoredBuffer.push(pooled);
    }

    return {
      scored: scoredBuffer,
      bestKey,
      bestScore: bestScore > 0 ? bestScore : 0,
      secondScore: secondScore > 0 ? secondScore : 0,
      currentWinnerScore,
    };
  }

  /**
   * OPTIMIZATION: Inline radius calculation using pre-computed radiusMulSq.
   */
  private scoreCandidate(candidate: CandidateWithDistance): number {
    const rect = candidate.rect;
    const minDim = rect.w < rect.h ? rect.w : rect.h;
    const radiusSq = this.derived.radiusMulSq * minDim * minDim;

    return this.core.hintVector(candidate.dx, candidate.dy, radiusSq);
  }

  /**
   * OPTIMIZATION: In-place sort and slice (no copy unless needed).
   */
  private prepareOutputTargets(): ScoredTarget[] {
    const buffer = this.scoredBuffer;
    const reportN = this.derived.reportTopN;

    // Early exit: no targets
    if (buffer.length === 0) return [];

    // Sort in-place by score descending
    buffer.sort((a, b) => b.score - a.score);

    // Return slice (only allocates if reportN < buffer.length)
    return reportN >= buffer.length ? buffer : buffer.slice(0, reportN);
  }

  // ========================================================================
  // Private - Winner Management
  // ========================================================================

  /**
   * CORRECTNESS: Prevents double-decay in no-evidence regime.
   * Only decay once per frame, not per call.
   */
  private updateWinnerScore(
    hasEvidence: boolean,
    currentWinnerScore: number,
  ): void {
    if (this.winnerKey === null) return;

    if (!hasEvidence) {
      // No-evidence regime: decay once per frame
      this.winnerScore *= this.config.decay;
      return;
    }

    // Evidence exists: update with measured score if available
    if (currentWinnerScore >= 0) {
      this.winnerScore = currentWinnerScore;
    }
  }

  // ========================================================================
  // Private - No Evidence Handling
  // ========================================================================

  private handleNoEvidence(
    deltaTimeMs: number,
    nearest: NearestCandidate,
    scoring: ScoringResult,
    margin: number,
    speed: number,
    top: ScoredTarget[],
  ): Selection {
    this.noEvidenceTimeMs += deltaTimeMs > 0 ? deltaTimeMs : 0;

    // Try to hold winner if still nearby
    if (this.canHoldWinner(nearest)) {
      this.clearPending();
      return this.createSelection(
        this.winnerKey,
        this.winnerScore,
        scoring,
        margin,
        nearest,
        speed,
        false,
        top,
      );
    }

    // Clear state if too long without evidence
    if (this.noEvidenceTimeMs >= this.config.clearAfterMs) {
      this.clearState();
    }

    return this.createSelection(
      null,
      scoring.bestScore,
      scoring,
      margin,
      nearest,
      speed,
      false,
      top,
    );
  }

  private canHoldWinner(nearest: NearestCandidate): boolean {
    if (this.winnerKey === null) return false;
    if (nearest.key !== this.winnerKey) return false;
    if (this.noEvidenceTimeMs > this.config.noEvidenceHoldMs) return false;

    return nearest.d2 <= this.derived.stickDistSq;
  }

  // ========================================================================
  // Private - Selection Determination
  // ========================================================================

  private determineSelection(
    scoring: ScoringResult,
    margin: number,
    nearest: NearestCandidate,
    speed: number,
    top: ScoredTarget[],
  ): Selection {
    // First winner
    if (this.winnerKey === null) {
      return this.establishFirstWinner(scoring, margin, nearest, speed, top);
    }

    // Same winner
    if (scoring.bestKey === this.winnerKey) {
      return this.confirmCurrentWinner(scoring, margin, nearest, speed, top);
    }

    // Evaluate potential switch
    return this.evaluateSwitch(scoring, margin, nearest, speed, top);
  }

  private establishFirstWinner(
    scoring: ScoringResult,
    margin: number,
    nearest: NearestCandidate,
    speed: number,
    top: ScoredTarget[],
  ): Selection {
    this.winnerKey = scoring.bestKey;
    this.winnerScore = scoring.bestScore;
    this.clearPending();

    const actuate = margin >= this.config.minMargin2nd;

    return this.createSelection(
      this.winnerKey,
      this.winnerScore,
      scoring,
      margin,
      nearest,
      speed,
      actuate,
      top,
    );
  }

  private confirmCurrentWinner(
    scoring: ScoringResult,
    margin: number,
    nearest: NearestCandidate,
    speed: number,
    top: ScoredTarget[],
  ): Selection {
    this.winnerScore = scoring.bestScore;
    this.clearPending();

    const actuate = margin >= this.config.minMargin2nd;

    return this.createSelection(
      this.winnerKey,
      this.winnerScore,
      scoring,
      margin,
      nearest,
      speed,
      actuate,
      top,
    );
  }

  private evaluateSwitch(
    scoring: ScoringResult,
    margin: number,
    nearest: NearestCandidate,
    speed: number,
    top: ScoredTarget[],
  ): Selection {
    const shouldSwitch =
      scoring.bestScore >= this.winnerScore + this.config.switchMargin &&
      margin >= this.config.minMargin2nd;

    if (!shouldSwitch) {
      return this.createSelection(
        this.winnerKey,
        this.winnerScore,
        scoring,
        margin,
        nearest,
        speed,
        false,
        top,
      );
    }

    return this.processSwitchDwell(scoring, margin, nearest, speed, top);
  }

  private processSwitchDwell(
    scoring: ScoringResult,
    margin: number,
    nearest: NearestCandidate,
    speed: number,
    top: ScoredTarget[],
  ): Selection {
    // New pending target
    if (this.pendingKey !== scoring.bestKey) {
      this.pendingKey = scoring.bestKey;
      this.pendingCount = 1;

      return this.createSelection(
        this.winnerKey,
        this.winnerScore,
        scoring,
        margin,
        nearest,
        speed,
        false,
        top,
      );
    }

    // Increment dwell counter
    this.pendingCount++;

    // Execute switch if dwell time met
    if (this.pendingCount >= this.derived.holdFrames) {
      this.winnerKey = scoring.bestKey;
      this.winnerScore = scoring.bestScore;
      this.clearPending();

      return this.createSelection(
        this.winnerKey,
        this.winnerScore,
        scoring,
        margin,
        nearest,
        speed,
        true,
        top,
      );
    }

    // Still dwelling
    return this.createSelection(
      this.winnerKey,
      this.winnerScore,
      scoring,
      margin,
      nearest,
      speed,
      false,
      top,
    );
  }

  // ========================================================================
  // Private - State Management
  // ========================================================================

  private clearPending(): void {
    this.pendingKey = null;
    this.pendingCount = 0;
  }

  private clearState(): void {
    this.winnerKey = null;
    this.winnerScore = ZERO_SCORE;
    this.clearPending();
    this.noEvidenceTimeMs = 0;
  }

  // ========================================================================
  // Private - Object Pool
  // ========================================================================

  /**
   * OPTIMIZATION: Acquire a pooled ScoredTarget object.
   * Reuses pre-allocated objects to avoid GC pressure.
   */
  private acquirePooledScored(
    key: IslandKey,
    score: number,
    d2: number,
  ): ScoredTarget {
    if (this.poolIdx < this.scoredPool.length) {
      const obj = this.scoredPool[this.poolIdx++];
      // Mutate in place (type assertion needed for readonly)
      (obj as { key: IslandKey }).key = key;
      (obj as { score: number }).score = score;
      (obj as { d2: number }).d2 = d2;
      return obj;
    }
    // Fallback: create new if pool exhausted
    return { key, score, d2 };
  }

  // ========================================================================
  // Private - Selection Creation
  // ========================================================================

  private createSelection(
    key: IslandKey | null,
    score: number,
    scoring: ScoringResult,
    margin: number,
    nearest: NearestCandidate,
    speed: number,
    actuate: boolean,
    top: ScoredTarget[],
  ): Selection {
    return {
      key,
      score,
      bestKey: scoring.bestKey,
      bestScore: scoring.bestScore,
      secondScore: scoring.secondScore,
      margin2nd: margin,
      nearestKey: nearest.key,
      nearestD2: nearest.d2,
      speed,
      actuate,
      pendingKey: this.pendingKey,
      pendingCount: this.pendingCount,
      top,
    };
  }
}

// ============================================================================
// Configuration Helpers
// ============================================================================

function computeDerived(config: TargetLockConfig): DerivedConfig {
  const topK = Math.max(1, config.topK | 0);
  const reportTopN = clamp(config.reportTopN | 0, 1, topK);
  const stickDistSq = Math.max(0, config.stickDistPx) ** 2;
  const radiusMulSq = Math.max(0, config.radiusMul) ** 2;
  const holdFrames = Math.max(1, config.holdFrames | 0);

  return { topK, reportTopN, stickDistSq, radiusMulSq, holdFrames };
}
