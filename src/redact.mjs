/**
 * Redaction engine for grow-loop.
 * Enforces Zero-Secret-Echo red line across events.jsonl, result.json,
 * lessons.md, and generated evidence packs.
 */

const BUILTIN_PATTERNS = [
  // JWT tokens
  { name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replace: '[REDACTED:JWT]' },
  // Bearer tokens (skip already-redacted placeholders)
  { name: 'bearer', regex: /\b(Bearer\s+)(?!\[REDACTED:[A-Z0-9_]+\])[A-Za-z0-9._~+/=-]{12,}/gi, replace: '$1[REDACTED:TOKEN]' },
  // Common provider API key prefixes
  { name: 'provider_key', regex: /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/g, replace: '[REDACTED:API_KEY]' },
  // Key-value secrets in logs/URLs/headers (skip already-redacted placeholders)
  {
    name: 'kv_secret',
    regex: /(["']?(?:api[_-]?key|app[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|passwd|secret[_-]?key|cookie|authorization)["']?\s*[:=]\s*["']?)(?!\[REDACTED:[A-Z0-9_]+\])([^\s"',;}{]{4,})(["']?)/gi,
    replace: '$1[REDACTED:SECRET]$3'
  },
  // Private / intranet IPv4 addresses (RFC1918)
  {
    name: 'intranet_ip',
    regex: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g,
    replace: '[REDACTED:INTRANET_IP]'
  },
  // Credentials embedded in URLs (http/https/postgres/mysql/redis/mongodb/etc.)
  {
    name: 'url_creds',
    regex: /\b([a-z][a-z0-9+.-]*:\/\/)(?!\[REDACTED:[A-Z0-9_]+\])([^:\s/@]+):(?!\[REDACTED:[A-Z0-9_]+\])([^@\s/]+)@/gi,
    replace: '$1[REDACTED:USER]:[REDACTED:PASS]@'
  }
];

/**
 * Compile optional user-provided extra redaction regex patterns from config.
 * @param {string[]} extraPatterns
 */
export function buildRedactor(extraPatterns = []) {
  const compiled = [...BUILTIN_PATTERNS];
  for (const raw of extraPatterns || []) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    try {
      compiled.push({
        name: 'custom',
        regex: new RegExp(raw, 'gi'),
        replace: '[REDACTED:INTERNAL]'
      });
    } catch {
      // Ignore malformed user regex rather than crashing the state machine
    }
  }

  function redactString(input) {
    if (typeof input !== 'string' || !input) return input;
    let out = input;
    for (const rule of compiled) {
      out = out.replace(rule.regex, rule.replace);
    }
    return out;
  }

  function redactValue(value) {
    if (typeof value === 'string') return redactString(value);
    if (Array.isArray(value)) return value.map(redactValue);
    if (value && typeof value === 'object') {
      const copy = {};
      for (const [k, v] of Object.entries(value)) {
        if (/^(?:api[_-]?key|app[_-]?secret|password|passwd|token|cookie|authorization|secret)$/i.test(k)) {
          copy[k] = '[REDACTED:SECRET]';
        } else {
          copy[k] = redactValue(v);
        }
      }
      return copy;
    }
    return value;
  }

  function scanString(input) {
    if (typeof input !== 'string' || !input) return [];
    const hits = [];
    for (const rule of compiled) {
      const re = new RegExp(rule.regex.source, rule.regex.flags);
      const matches = input.match(re);
      if (matches && matches.length > 0) {
        hits.push({ rule: rule.name, count: matches.length });
      }
    }
    return hits;
  }

  return { redactString, redactValue, scanString };
}

export const defaultRedactor = buildRedactor();
