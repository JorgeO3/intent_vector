// runtime/targetLock.ts
import type { IntentVector } from "../intent/intentVector.ts";
import type {
  Candidate,
  IslandKey,
  Rect,
  ScoredTarget,
  Selection,
} from "./types.ts";

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

const NO_SCORE = -1;
const ZERO_SCORE = 0;
const INFINITE_DISTANCE = Infinity;

// ============================================================================
// Utility Functions
// ============================================================================

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

// ============================================================================
// Target Lock Class
// ============================================================================

export class TargetLock {
  private readonly core: IntentVector;
  private config: TargetLockConfig;

  private winnerKey: IslandKey | null = null;
  private winnerScore = ZERO_SCORE;

  private pendingKey: IslandKey | null = null;
  private pendingCount = 0;

  private noEvidenceTimeMs = 0;

  constructor(core: IntentVector, config?: Partial<TargetLockConfig>) {
    this.core = core;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  setConfig(config: Partial<TargetLockConfig>): void {
    this.config = { ...this.config, ...config };
  }

  reset(): void {
    this.winnerKey = null;
    this.winnerScore = ZERO_SCORE;
    this.pendingKey = null;
    this.pendingCount = 0;
    this.noEvidenceTimeMs = 0;
  }

  select(
    candidates: Candidate[],
    deltaTimeMs = DEFAULT_FRAME_TIME_MS,
  ): Selection {
    const kinematics = this.core.getKinematics();
    const speed = Math.sqrt(kinematics.v2);

    // Build top-K candidates by distance
    const topK = this.buildTopKCandidates(
      candidates,
      kinematics.px,
      kinematics.py,
    );
    const nearest = this.findNearestCandidate(
      candidates,
      kinematics.px,
      kinematics.py,
    );

    // Score candidates
    const scoringResult = this.scoreCandidates(topK);

    // Update winner score with decay if needed
    this.updateWinnerScore(scoringResult.currentWinnerScore);

    // Prepare scored targets for output
    const scoredTargets = this.prepareOutputTargets(scoringResult.scored);

    const margin = scoringResult.bestScore - scoringResult.secondScore;
    const hasEvidence = this.hasValidEvidence(
      scoringResult.bestKey,
      scoringResult.bestScore,
    );

    // Handle no-evidence case
    if (!hasEvidence) {
      return this.handleNoEvidence(
        deltaTimeMs,
        nearest,
        scoringResult,
        margin,
        speed,
        scoredTargets,
      );
    }

    // Evidence restored
    this.noEvidenceTimeMs = 0;

    // Determine selection state
    return this.determineSelection(
      scoringResult,
      margin,
      nearest,
      speed,
      scoredTargets,
    );
  }

  // ========================================================================
  // Private - Candidate Processing
  // ========================================================================

  private buildTopKCandidates(
    candidates: Candidate[],
    px: number,
    py: number,
  ): CandidateWithDistance[] {
    const k = Math.max(1, this.config.topK | 0);
    const topK: CandidateWithDistance[] = [];

    for (const candidate of candidates) {
      const distance = this.computeCandidateDistance(candidate, px, py);
      this.insertSortedByDistance(topK, distance, k);
    }

    // Force-include current winner
    this.ensureWinnerIncluded(candidates, px, py, topK, k);

    return topK;
  }

  private computeCandidateDistance(
    candidate: Candidate,
    px: number,
    py: number,
  ): CandidateWithDistance {
    const closestPoint = this.findClosestPointInRect(candidate.rect, px, py);
    const dx = closestPoint.x - px;
    const dy = closestPoint.y - py;
    const d2 = dx * dx + dy * dy;

    return {
      key: candidate.key,
      rect: candidate.rect,
      d2,
      dx,
      dy,
    };
  }

  private findClosestPointInRect(
    rect: Rect,
    px: number,
    py: number,
  ): { x: number; y: number } {
    const x = clamp(px, rect.x, rect.x + rect.w);
    const y = clamp(py, rect.y, rect.y + rect.h);
    return { x, y };
  }

  private insertSortedByDistance(
    array: CandidateWithDistance[],
    item: CandidateWithDistance,
    maxSize: number,
  ): void {
    if (array.length === maxSize && item.d2 >= array[maxSize - 1].d2) {
      return;
    }

    let insertIndex = 0;
    while (insertIndex < array.length && array[insertIndex].d2 <= item.d2) {
      insertIndex++;
    }

    array.splice(insertIndex, 0, item);

    if (array.length > maxSize) {
      array.length = maxSize;
    }
  }

  private ensureWinnerIncluded(
    candidates: Candidate[],
    px: number,
    py: number,
    topK: CandidateWithDistance[],
    k: number,
  ): void {
    if (this.winnerKey === null) return;

    const winnerInTopK = topK.some((item) => item.key === this.winnerKey);
    if (winnerInTopK) return;

    const winnerCandidate = candidates.find((c) => c.key === this.winnerKey);
    if (!winnerCandidate) return;

    const winnerDistance = this.computeCandidateDistance(
      winnerCandidate,
      px,
      py,
    );
    this.insertSortedByDistance(topK, winnerDistance, k);
  }

  private findNearestCandidate(
    candidates: Candidate[],
    px: number,
    py: number,
  ): NearestCandidate {
    let nearestKey: IslandKey | null = null;
    let nearestD2 = INFINITE_DISTANCE;

    for (const candidate of candidates) {
      const distance = this.computeCandidateDistance(candidate, px, py);

      if (distance.d2 < nearestD2) {
        nearestD2 = distance.d2;
        nearestKey = distance.key;
      }
    }

    return { key: nearestKey, d2: nearestD2 };
  }

  // ========================================================================
  // Private - Scoring
  // ========================================================================

  private scoreCandidates(topK: CandidateWithDistance[]): ScoringResult {
    let bestKey: IslandKey | null = null;
    let bestScore = NO_SCORE;
    let secondScore = NO_SCORE;
    let currentWinnerScore = NO_SCORE;

    const scored: ScoredTarget[] = [];

    for (const candidate of topK) {
      const score = this.scoreCandidate(candidate);

      if (this.winnerKey !== null && candidate.key === this.winnerKey) {
        currentWinnerScore = score;
      }

      if (score > bestScore) {
        secondScore = bestScore;
        bestScore = score;
        bestKey = candidate.key;
      } else if (score > secondScore) {
        secondScore = score;
      }

      scored.push({
        key: candidate.key,
        score,
        d2: candidate.d2,
      });
    }

    return {
      scored,
      bestKey,
      bestScore: Math.max(bestScore, ZERO_SCORE),
      secondScore: Math.max(secondScore, ZERO_SCORE),
      currentWinnerScore,
    };
  }

  private scoreCandidate(candidate: CandidateWithDistance): number {
    const radiusSq = this.computeTargetRadiusSquared(candidate.rect);
    return this.core.hintVector(candidate.dx, candidate.dy, radiusSq);
  }

  private computeTargetRadiusSquared(rect: Rect): number {
    const radius = this.config.radiusMul * Math.min(rect.w, rect.h);
    return radius * radius;
  }

  private prepareOutputTargets(scored: ScoredTarget[]): ScoredTarget[] {
    const reportN = clamp(this.config.reportTopN | 0, 1, this.config.topK);
    const sorted = [...scored].sort((a, b) => b.score - a.score);
    return sorted.slice(0, reportN);
  }

  // ========================================================================
  // Private - Winner Management
  // ========================================================================

  private updateWinnerScore(currentWinnerScore: number): void {
    if (this.winnerKey === null) return;

    if (currentWinnerScore >= 0) {
      this.winnerScore = currentWinnerScore;
    } else {
      this.winnerScore *= this.config.decay;
    }
  }

  private hasValidEvidence(
    bestKey: IslandKey | null,
    bestScore: number,
  ): boolean {
    return bestKey !== null && bestScore >= this.config.scoreFloor;
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
    scoredTargets: ScoredTarget[],
  ): Selection {
    this.noEvidenceTimeMs += Math.max(0, deltaTimeMs);

    // Try to hold onto winner if still nearby
    if (this.canHoldWinner(nearest)) {
      return this.createSelectionWithHeldWinner(
        scoring,
        margin,
        nearest,
        speed,
        scoredTargets,
      );
    }

    // Clear if too long without evidence
    if (this.noEvidenceTimeMs >= this.config.clearAfterMs) {
      this.clearState();
    }

    return this.createNoSelectionResult(
      scoring,
      margin,
      nearest,
      speed,
      scoredTargets,
    );
  }

  private canHoldWinner(nearest: NearestCandidate): boolean {
    if (this.winnerKey === null) return false;
    if (nearest.key !== this.winnerKey) return false;
    if (this.noEvidenceTimeMs > this.config.noEvidenceHoldMs) return false;

    const stickDistSq = this.config.stickDistPx * this.config.stickDistPx;
    return nearest.d2 <= stickDistSq;
  }

  private createSelectionWithHeldWinner(
    scoring: ScoringResult,
    margin: number,
    nearest: NearestCandidate,
    speed: number,
    scoredTargets: ScoredTarget[],
  ): Selection {
    this.winnerScore *= this.config.decay;
    this.clearPending();

    return this.createSelection(
      this.winnerKey,
      this.winnerScore,
      scoring,
      margin,
      nearest,
      speed,
      false,
      scoredTargets,
    );
  }

  private createNoSelectionResult(
    scoring: ScoringResult,
    margin: number,
    nearest: NearestCandidate,
    speed: number,
    scoredTargets: ScoredTarget[],
  ): Selection {
    return this.createSelection(
      null,
      scoring.bestScore,
      scoring,
      margin,
      nearest,
      speed,
      false,
      scoredTargets,
    );
  }

  // ========================================================================
  // Private - Selection Determination
  // ========================================================================

  private determineSelection(
    scoring: ScoringResult,
    margin: number,
    nearest: NearestCandidate,
    speed: number,
    scoredTargets: ScoredTarget[],
  ): Selection {
    // First winner
    if (this.winnerKey === null) {
      return this.establishFirstWinner(
        scoring,
        margin,
        nearest,
        speed,
        scoredTargets,
      );
    }

    // Same winner
    if (scoring.bestKey === this.winnerKey) {
      return this.confirmCurrentWinner(
        scoring,
        margin,
        nearest,
        speed,
        scoredTargets,
      );
    }

    // Potential switch
    return this.evaluateSwitch(scoring, margin, nearest, speed, scoredTargets);
  }

  private establishFirstWinner(
    scoring: ScoringResult,
    margin: number,
    nearest: NearestCandidate,
    speed: number,
    scoredTargets: ScoredTarget[],
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
      scoredTargets,
    );
  }

  private confirmCurrentWinner(
    scoring: ScoringResult,
    margin: number,
    nearest: NearestCandidate,
    speed: number,
    scoredTargets: ScoredTarget[],
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
      scoredTargets,
    );
  }

  private evaluateSwitch(
    scoring: ScoringResult,
    margin: number,
    nearest: NearestCandidate,
    speed: number,
    scoredTargets: ScoredTarget[],
  ): Selection {
    const shouldSwitch = this.shouldSwitchWinner(scoring, margin);

    if (!shouldSwitch) {
      return this.createSelection(
        this.winnerKey,
        this.winnerScore,
        scoring,
        margin,
        nearest,
        speed,
        false,
        scoredTargets,
      );
    }

    return this.processSwitchDwell(
      scoring,
      margin,
      nearest,
      speed,
      scoredTargets,
    );
  }

  private shouldSwitchWinner(scoring: ScoringResult, margin: number): boolean {
    return (
      scoring.bestScore >= this.winnerScore + this.config.switchMargin &&
      margin >= this.config.minMargin2nd
    );
  }

  private processSwitchDwell(
    scoring: ScoringResult,
    margin: number,
    nearest: NearestCandidate,
    speed: number,
    scoredTargets: ScoredTarget[],
  ): Selection {
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
        scoredTargets,
      );
    }

    this.pendingCount++;

    if (this.pendingCount >= this.config.holdFrames) {
      return this.executeSwitch(scoring, margin, nearest, speed, scoredTargets);
    }

    return this.createSelection(
      this.winnerKey,
      this.winnerScore,
      scoring,
      margin,
      nearest,
      speed,
      false,
      scoredTargets,
    );
  }

  private executeSwitch(
    scoring: ScoringResult,
    margin: number,
    nearest: NearestCandidate,
    speed: number,
    scoredTargets: ScoredTarget[],
  ): Selection {
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
      scoredTargets,
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
    scoredTargets: ScoredTarget[],
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
      top: scoredTargets,
    };
  }
}
