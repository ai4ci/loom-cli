/** Severity of a diagnostic. Errors fail a run; warnings do not. */
export type Severity = "error" | "warning";

/**
 * A single validation finding. Shape is part of the CLI's public contract
 * (plan §1.4), so fields are added rather than renamed.
 */
export interface Diagnostic {
  severity: Severity;
  /** Stable machine-readable identifier, e.g. "uri/unknown-scheme". */
  code: string;
  /** Canonical URI of the subject, when there is one. */
  uri?: string;
  /** 1-indexed line within the subject, when known. */
  line?: number;
  message: string;
  /** How to repair it, when the repair is unambiguous. */
  fix?: string;
}

/** Thrown for conditions the caller is expected to report, not stack-trace. */
export class DesignDocsError extends Error {
  readonly diagnostic: Diagnostic;

  constructor(diagnostic: Diagnostic) {
    super(diagnostic.message);
    this.name = "DesignDocsError";
    this.diagnostic = diagnostic;
  }
}

export function error(code: string, message: string, rest: Partial<Diagnostic> = {}): Diagnostic {
  return { severity: "error", code, message, ...rest };
}

export function warning(code: string, message: string, rest: Partial<Diagnostic> = {}): Diagnostic {
  return { severity: "warning", code, message, ...rest };
}
