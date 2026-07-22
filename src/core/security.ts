const secretPatterns = [
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\b(?:secret|token|password|api[_-]?key)\s*[:=]\s*[^\s,;}]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi,
  /\bntn_[A-Za-z0-9]+\b/g,
  /\bsecret_[A-Za-z0-9]+\b/g,
];

export function redact(value: unknown): string {
  let text =
    typeof value === "string"
      ? value
      : JSON.stringify(value, (key, item) => {
          if (/(?:secret|token|password|api[_-]?key|authorization)/i.test(key)) {
            return "[REDACTED]";
          }
          return typeof item === "bigint" ? item.toString() : item;
        });
  for (const pattern of secretPatterns) {
    text = text.replace(pattern, "[REDACTED]");
  }
  return text;
}

export async function withTimeout<T>(
  operation: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const suffix = "\n[truncated]";
  if (maximum <= suffix.length) return suffix.slice(0, maximum);
  return `${value.slice(0, maximum - suffix.length)}${suffix}`;
}
