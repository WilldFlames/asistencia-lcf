const test = require("node:test");
const assert = require("node:assert/strict");

const {
  validateSecurityConfig,
  parseAllowedOrigins,
  containsMarkup,
  csrfProtection,
  createRateLimiter,
} = require("../middleware/security");

test("produccion exige un SESSION_SECRET fuerte", () => {
  assert.throws(
    () => validateSecurityConfig({ NODE_ENV: "production", DATABASE_URL: "postgres://db" }),
    /SESSION_SECRET/
  );
  assert.throws(
    () => validateSecurityConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://db",
      SESSION_SECRET: "lcf-asistencia-secret-2024",
    }),
    /SESSION_SECRET/
  );
  assert.doesNotThrow(() => validateSecurityConfig({
    NODE_ENV: "production",
    DATABASE_URL: "postgres://db",
    SESSION_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef",
  }));
});

test("los origenes configurados se normalizan", () => {
  assert.deepEqual(
    parseAllowedOrigins({ APP_ORIGIN: "https://uno.test/, https://dos.test" }),
    ["https://uno.test", "https://dos.test"]
  );
});

test("se detecta marcado activo anidado", () => {
  assert.equal(containsMarkup({ texto: "normal" }), false);
  assert.equal(containsMarkup({ pasos: [{ texto: "<script>alert(1)</script>" }] }), true);
  assert.equal(containsMarkup({ foto: "<img src=x onerror=alert(1)>" }), true);
  assert.equal(containsMarkup({ url: "javascript:alert(1)" }), true);
});

test("CSRF exige cabecera AJAX y rechaza origen externo", () => {
  const middleware = csrfProtection({ allowedOrigins: ["https://permitido.test"] });
  const makeRes = () => ({
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  });

  let nextCalled = false;
  let res = makeRes();
  middleware({ path: "/api/auth/login", method: "POST", get: () => undefined }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);

  res = makeRes();
  const externalHeaders = { "X-Requested-With": "XMLHttpRequest", Origin: "https://externo.test" };
  middleware({ path: "/api/auth/login", method: "POST", get: name => externalHeaders[name] }, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 403);

  nextCalled = false;
  res = makeRes();
  const validHeaders = { "X-Requested-With": "XMLHttpRequest", Origin: "https://permitido.test" };
  middleware({ path: "/api/auth/login", method: "POST", get: name => validHeaders[name] }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test("el limitador bloquea al superar el maximo configurado", () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });
  const req = { body: { cedula: "123" }, ip: "127.0.0.1", socket: {}, path: "/api/auth/login" };
  const makeRes = () => ({
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  });

  let allowed = 0;
  limiter(req, makeRes(), () => { allowed += 1; });
  limiter(req, makeRes(), () => { allowed += 1; });
  const blocked = makeRes();
  limiter(req, blocked, () => { allowed += 1; });
  assert.equal(allowed, 2);
  assert.equal(blocked.statusCode, 429);
});
