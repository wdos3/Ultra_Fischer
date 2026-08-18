import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import auth from "./auth.js";

const originalFetch = globalThis.fetch;

process.env.APP_BASE_URL = "http://localhost:4175";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
process.env.AUTH_SECRET = "test-only-secret-that-is-long-enough";

function response(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
  };
}

function mockResponse() {
  const headers = new Map();
  return {
    headers,
    statusCode: 200,
    getHeader(name) {
      return headers.get(name);
    },
    setHeader(name, value) {
      headers.set(name, value);
    },
    end(body) {
      this.body = body;
    },
  };
}

function request(action, body, headers = { origin: "http://localhost:4175" }) {
  return {
    method: "POST",
    headers,
    body,
    query: { action },
    socket: { remoteAddress: "127.0.0.1" },
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("normalizes email and enforces long passwords", () => {
  assert.equal(auth.normalizeEmail("  PLAYER@Example.COM "), "player@example.com");
  assert.equal(auth.validatePassword("short"), "Use a password with at least 15 characters.");
  assert.equal(auth.validatePassword("a".repeat(15)), "");
  assert.equal(auth.isValidEmail("player@example.com"), true);
  assert.equal(auth.isValidEmail("not-an-email"), false);
});

test("masks email addresses without exposing the full local part", () => {
  assert.equal(auth.maskEmail("player@example.com"), "pl****@example.com");
  assert.equal(auth.maskEmail("a@example.com"), "a*@example.com");
});

test("rejects state-changing requests without an allowed origin", async () => {
  const res = mockResponse();
  await auth.route(request("login", { email: "player@example.com", password: "a".repeat(15) }, {}), res);
  assert.equal(res.statusCode, 403);
  assert.match(res.body, /origin_not_allowed/);
});

test("login sets server-only session cookies and never returns tokens", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.includes("consume_auth_rate_limit")) return response(true);
    return response({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 3600,
      user: { id: "user-1", email: "player@example.com", email_confirmed_at: "2026-08-18T00:00:00Z" },
    });
  };
  const res = mockResponse();
  await auth.route(request("login", { email: "player@example.com", password: "a".repeat(15) }), res);
  assert.equal(res.statusCode, 200);
  assert.doesNotMatch(res.body, /access-token|refresh-token/);
  const cookies = res.headers.get("Set-Cookie");
  assert.equal(cookies.length, 2);
  assert.match(cookies[0], /__Host-uf-access=.*HttpOnly.*Secure.*SameSite=Lax/);
  assert.match(cookies[1], /__Host-uf-refresh=.*HttpOnly.*Secure.*SameSite=Lax/);
  const rateLimitCalls = calls.filter((call) => call.url.includes("consume_auth_rate_limit"));
  assert.equal(rateLimitCalls.length, 2);
  assert.equal(rateLimitCalls[0].options.headers.Authorization, "Bearer service-key");
});

test("rate limiting stops auth work before the provider is called", async () => {
  let providerCalls = 0;
  globalThis.fetch = async (url) => {
    if (url.includes("consume_auth_rate_limit")) return response(false);
    providerCalls += 1;
    return response({});
  };
  const res = mockResponse();
  await auth.route(request("login", { email: "player@example.com", password: "a".repeat(15) }), res);
  assert.equal(res.statusCode, 429);
  assert.equal(providerCalls, 0);
  assert.match(res.body, /rate_limited/);
});
