const TOKEN_SECRET_KEY = '(?:(?:access|refresh|id|auth|bearer)[-_]?token|token|(?:client[-_]?)?secret|private[-_]?key)';
const QUOTED_SECRET_KEY = `(?:authorization|x[-_]?api[-_]?key|api[-_]?key|${TOKEN_SECRET_KEY})`;
const ASSIGNED_SECRET_KEY = `(?:x[-_]?api[-_]?key|api[-_]?key|${TOKEN_SECRET_KEY})`;

/** Bounded, display-safe provider diagnostics. This is not a general-purpose secret scanner. */
export function sanitizeAiDiagnosticText(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.trim()
    .replace(
      new RegExp(`(["']?${QUOTED_SECRET_KEY}["']?\\s*:\\s*["'])([^"']*)(["'])`, 'giu'),
      '$1[REDACTED]$3',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/giu, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED]')
    .replace(
      new RegExp(`\\b(${ASSIGNED_SECRET_KEY})(\\s*[:=]\\s*)[^\\s,;}]+`, 'giu'),
      '$1$2[REDACTED]',
    )
    .slice(0, 1_000);
}
