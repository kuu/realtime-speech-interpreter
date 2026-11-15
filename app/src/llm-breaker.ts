// Circuit breaker and error classification for the LLM engine. Pure, injectable clock.
//   hard    : open at once (throttling, access, bad config: will repeat)
//   soft    : open after SOFT_THRESHOLD consecutive (timeouts, 5xx, network, unknown)
//   content : open after CONTENT_THRESHOLD consecutive (output validation rejections)
// Open lasts openMs, then one half-open trial: success closes, failure re-opens.

export type FailureKind = "hard" | "soft" | "content";
export type BreakerState = "closed" | "open" | "half-open";

export interface Classified {
  kind: FailureKind;
  reason: string; // fallbackReason
}

export class LlmTimeoutError extends Error {
  constructor(ms: number) {
    super(`LLM call timed out after ${ms} ms`);
    this.name = "LlmTimeoutError";
  }
}

const HARD: Record<string, string> = {
  ThrottlingException: "throttled",
  TooManyRequestsException: "throttled",
  ModelNotReadyException: "model-not-ready",
  AccessDeniedException: "access",
  UnrecognizedClientException: "access",
  ExpiredTokenException: "access",
  ResourceNotFoundException: "bad-request",
  ValidationException: "bad-request",
};
const TIMEOUT_NAMES = new Set(["LlmTimeoutError", "AbortError", "TimeoutError", "ModelTimeoutException"]);
const SERVER_NAMES = new Set(["ServiceUnavailableException", "InternalServerException", "ModelErrorException"]);
const NETWORK_CODES = new Set(["ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "EPIPE"]);

export function classifyError(err: unknown): Classified {
  const e = err as {
    name?: string;
    code?: string;
    __type?: string;
    cause?: { code?: string; name?: string };
    $metadata?: { httpStatusCode?: number };
  } | null;
  const names = [e?.name, e?.code, e?.__type?.split("#").pop(), e?.cause?.name].filter((x): x is string => typeof x === "string");
  for (const n of names) if (HARD[n]) return { kind: "hard", reason: HARD[n] };
  if (e?.$metadata?.httpStatusCode === 429) return { kind: "hard", reason: "throttled" };
  for (const n of names) if (TIMEOUT_NAMES.has(n)) return { kind: "soft", reason: "timeout" };
  for (const n of names) if (SERVER_NAMES.has(n)) return { kind: "soft", reason: "server-error" };
  const codes = [e?.code, e?.cause?.code].filter((x): x is string => typeof x === "string");
  if (codes.some((c) => NETWORK_CODES.has(c)) || names.includes("NetworkingError")) return { kind: "soft", reason: "network" };
  return { kind: "soft", reason: "unknown" };
}

export interface BreakerOptions {
  openMs: number;
  now: () => number;
  softThreshold?: number;
  contentThreshold?: number;
  onTransition?: (to: BreakerState, reason: string, forMs: number) => void;
}

export class CircuitBreaker {
  private st: BreakerState = "closed";
  private openUntil = 0;
  private soft = 0;
  private content = 0;
  private trialInFlight = false;
  private readonly softThreshold: number;
  private readonly contentThreshold: number;

  constructor(private readonly o: BreakerOptions) {
    this.softThreshold = o.softThreshold ?? 3;
    this.contentThreshold = o.contentThreshold ?? 5;
  }

  get state(): BreakerState {
    return this.st;
  }

  // True when a call may be made now. In half-open exactly one trial is admitted.
  allow(): boolean {
    if (this.st === "closed") return true;
    if (this.st === "open") {
      if (this.o.now() < this.openUntil) return false;
      this.st = "half-open";
      this.trialInFlight = false;
      this.o.onTransition?.("half-open", "window elapsed", 0);
    }
    if (this.trialInFlight) return false;
    this.trialInFlight = true;
    return true;
  }

  onSuccess(): void {
    this.soft = 0;
    this.content = 0;
    if (this.st !== "closed") {
      this.st = "closed";
      this.trialInFlight = false;
      this.o.onTransition?.("closed", "trial succeeded", 0);
    }
  }

  onFailure(kind: FailureKind, reason: string): void {
    if (this.st === "half-open") {
      this.open(`trial failed: ${reason}`);
      return;
    }
    if (this.st === "open") return;
    if (kind === "hard") {
      this.open(reason);
    } else if (kind === "soft") {
      this.soft++;
      this.content = 0;
      if (this.soft >= this.softThreshold) this.open(`${this.soft} consecutive ${reason}`);
    } else {
      this.content++;
      this.soft = 0;
      if (this.content >= this.contentThreshold) this.open(`${this.content} consecutive ${reason}`);
    }
  }

  private open(reason: string): void {
    this.st = "open";
    this.trialInFlight = false;
    this.soft = 0;
    this.content = 0;
    this.openUntil = this.o.now() + this.o.openMs;
    this.o.onTransition?.("open", reason, this.o.openMs);
  }
}
