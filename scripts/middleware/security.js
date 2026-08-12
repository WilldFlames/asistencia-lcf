const crypto = require("crypto");

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const INSECURE_SESSION_SECRETS = new Set([
  "lcf-asistencia-secret-2024",
  "cambiar-por-clave-secreta-larga",
  "change-me",
]);

function validateSecurityConfig(env = process.env) {
  const production = env.NODE_ENV === "production";
  const secret = String(env.SESSION_SECRET || "");

  if (production && (!secret || secret.length < 32 || INSECURE_SESSION_SECRETS.has(secret))) {
    throw new Error(
      "SESSION_SECRET es obligatorio en produccion y debe tener al menos 32 caracteres aleatorios."
    );
  }

  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL es obligatorio.");
  }
}

function getSessionSecret(env = process.env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  // Solo desarrollo local. En produccion validateSecurityConfig impide llegar aqui.
  return crypto.randomBytes(48).toString("hex");
}

function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "form-action 'self'",
      "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "worker-src 'self' blob: https://cdnjs.cloudflare.com",
    ].join("; ")
  );
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
}

function parseAllowedOrigins(env = process.env) {
  return String(env.APP_ORIGIN || "https://www.liccallefallas.com,https://liccallefallas.com")
    .split(",")
    .map(value => value.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function csrfProtection(options = {}) {
  const allowedOrigins = options.allowedOrigins || parseAllowedOrigins();
  return (req, res, next) => {
    if (!req.path.startsWith("/api/") || !UNSAFE_METHODS.has(req.method)) return next();

    if (req.get("X-Requested-With") !== "XMLHttpRequest") {
      return res.status(403).json({ error: "Solicitud rechazada por proteccion CSRF." });
    }

    const origin = req.get("Origin");
    if (origin && !allowedOrigins.includes(origin.replace(/\/$/, ""))) {
      return res.status(403).json({ error: "Origen no autorizado." });
    }
    next();
  };
}

function containsMarkup(value) {
  if (typeof value === "string") {
    return /<\s*\/?\s*[a-z][^>]*>|javascript\s*:|\bon[a-z]+\s*=/i.test(value);
  }
  if (Array.isArray(value)) return value.some(containsMarkup);
  if (value && typeof value === "object") return Object.values(value).some(containsMarkup);
  return false;
}

function rejectActiveMarkup(req, res, next) {
  if (!UNSAFE_METHODS.has(req.method) || !req.path.startsWith("/api/")) return next();
  if (containsMarkup(req.body)) {
    return res.status(400).json({ error: "El contenido incluye marcado activo no permitido." });
  }
  next();
}

function hideProductionErrors(req, res, next) {
  if (process.env.NODE_ENV !== "production") return next();
  const originalJson = res.json.bind(res);
  res.json = payload => {
    if (res.statusCode >= 500 && payload && typeof payload === "object" && payload.error) {
      return originalJson({ error: "Error interno del servidor. Si persiste, contacte al administrador." });
    }
    return originalJson(payload);
  };
  next();
}

function createRateLimiter({ windowMs, max, message }) {
  const attempts = new Map();

  function cleanup(now) {
    if (attempts.size < 1000) return;
    for (const [key, entry] of attempts) {
      if (entry.resetAt <= now) attempts.delete(key);
    }
  }

  const middleware = (req, res, next) => {
    const now = Date.now();
    cleanup(now);
    const identity = String(req.body?.cedula || "").replace(/[^0-9A-Za-z]/g, "").toLowerCase();
    const key = `${req.ip || req.socket?.remoteAddress || "unknown"}:${identity}`;
    let entry = attempts.get(key);
    if (!entry || entry.resetAt <= now) entry = { count: 0, resetAt: now + windowMs };
    entry.count += 1;
    attempts.set(key, entry);

    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - entry.count)));
    if (entry.count > max) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ error: message || "Demasiados intentos. Intente nuevamente mas tarde." });
    }
    next();
  };

  middleware.reset = req => {
    const identity = String(req.body?.cedula || "").replace(/[^0-9A-Za-z]/g, "").toLowerCase();
    const key = `${req.ip || req.socket?.remoteAddress || "unknown"}:${identity}`;
    attempts.delete(key);
  };

  return middleware;
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate(error => (error ? reject(error) : resolve()));
  });
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save(error => (error ? reject(error) : resolve()));
  });
}

module.exports = {
  validateSecurityConfig,
  getSessionSecret,
  securityHeaders,
  csrfProtection,
  rejectActiveMarkup,
  hideProductionErrors,
  createRateLimiter,
  regenerateSession,
  saveSession,
  parseAllowedOrigins,
  containsMarkup,
};
