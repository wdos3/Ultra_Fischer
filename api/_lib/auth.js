const crypto = require("node:crypto");

const ACCESS_COOKIE = "__Host-uf-access";
const REFRESH_COOKIE = "__Host-uf-refresh";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
const MAX_BODY_BYTES = 32 * 1024;
const GENERIC_MESSAGE = "We could not complete that request. Check the details and try again.";
const GENERIC_EMAIL_MESSAGE = "If an account matches that email, we sent the next steps.";

class HttpError extends Error {
  constructor(status, message, code = "request_failed") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

class ConfigError extends Error {}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new ConfigError(`Missing server configuration: ${name}`);
  }
  return value.trim();
}

function getConfig() {
  const appBaseUrl = requiredEnv("APP_BASE_URL").replace(/\/$/, "");
  let baseUrl;
  try {
    baseUrl = new URL(appBaseUrl);
  } catch {
    throw new ConfigError("APP_BASE_URL must be a valid URL.");
  }
  if (baseUrl.protocol !== "https:" && baseUrl.hostname !== "localhost" && baseUrl.hostname !== "127.0.0.1") {
    throw new ConfigError("APP_BASE_URL must use HTTPS outside local development.");
  }
  const authSecret = requiredEnv("AUTH_SECRET");
  if (authSecret.length < 32) {
    throw new ConfigError("AUTH_SECRET must be at least 32 characters.");
  }

  return {
    appBaseUrl,
    authSecret,
    anonKey: requiredEnv("SUPABASE_ANON_KEY"),
    serviceRoleKey: requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    supabaseUrl: requiredEnv("SUPABASE_URL").replace(/\/$/, ""),
    allowedOrigins: new Set([
      baseUrl.origin,
      ...(process.env.ALLOWED_ORIGINS || "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ]),
  };
}

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isValidEmail(email) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < 15) {
    return "Use a password with at least 15 characters.";
  }
  if (password.length > 1024) {
    return "Use a password shorter than 1024 characters.";
  }
  return "";
}

function maskEmail(email) {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "your email address";
  const visible = local.length < 3 ? local[0] : local.slice(0, 2);
  return `${visible}${"*".repeat(Math.max(1, local.length - visible.length))}@${domain}`;
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return String(req.headers["x-real-ip"] || req.socket?.remoteAddress || "unknown").trim();
}

function hashIdentifier(value, secret) {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = {};
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

function cookieValue(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function appendCookie(res, value) {
  const current = res.getHeader("Set-Cookie");
  res.setHeader("Set-Cookie", current ? (Array.isArray(current) ? [...current, value] : [current, value]) : [value]);
}

function setSessionCookies(res, session) {
  if (!session?.access_token || !session?.refresh_token) {
    throw new HttpError(502, "The authentication provider returned an invalid session.", "provider_session_error");
  }
  const accessAge = Number.isFinite(Number(session.expires_in)) ? Math.max(60, Number(session.expires_in)) : 3600;
  appendCookie(res, cookieValue(ACCESS_COOKIE, session.access_token, accessAge));
  appendCookie(res, cookieValue(REFRESH_COOKIE, session.refresh_token, SESSION_MAX_AGE));
}

function clearSessionCookies(res) {
  appendCookie(res, cookieValue(ACCESS_COOKIE, "", 0));
  appendCookie(res, cookieValue(REFRESH_COOKIE, "", 0));
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Vary", "Origin");
  res.end(JSON.stringify(payload));
}

function sendError(res, error) {
  if (error instanceof ConfigError) {
    return sendJson(res, 503, { error: "Authentication is not configured on this deployment." });
  }
  if (error instanceof HttpError) {
    return sendJson(res, error.status, { error: error.message, code: error.code });
  }
  console.error("Unhandled auth route error", error instanceof Error ? error.message : error);
  return sendJson(res, 500, { error: GENERIC_MESSAGE, code: "server_error" });
}

function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) {
    throw new HttpError(403, "Request origin not allowed.", "origin_not_allowed");
  }
  const config = getConfig();
  if (!config.allowedOrigins.has(origin)) {
    throw new HttpError(403, "Request origin not allowed.", "origin_not_allowed");
  }
}

function methodNotAllowed(res, methods) {
  res.setHeader("Allow", methods.join(", "));
  return sendJson(res, 405, { error: "Method not allowed.", code: "method_not_allowed" });
}

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
      throw new HttpError(413, "Request body is too large.", "body_too_large");
    }
  }
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.", "invalid_json");
  }
}

function providerHeaders(apiKey, accessToken) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    apikey: apiKey,
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };
}

async function providerRequest(path, { method = "GET", body, accessToken, useServiceRole = false } = {}) {
  const config = getConfig();
  const apiKey = useServiceRole ? config.serviceRoleKey : config.anonKey;
  const response = await fetch(`${config.supabaseUrl}${path}`, {
    method,
    headers: providerHeaders(apiKey, accessToken),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return { data, ok: response.ok, status: response.status };
}

function providerMessage(result) {
  return String(result.data?.message || result.data?.msg || result.data?.error_description || result.data?.error || "").toLowerCase();
}

function userPayload(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    emailConfirmedAt: user.email_confirmed_at || null,
  };
}

async function refreshSession(refreshToken) {
  const result = await providerRequest("/auth/v1/token?grant_type=refresh_token", {
    method: "POST",
    body: { refresh_token: refreshToken },
  });
  return result.ok ? result.data : null;
}

async function loadSession(req) {
  const cookies = parseCookies(req);
  let accessToken = cookies[ACCESS_COOKIE];
  const refreshToken = cookies[REFRESH_COOKIE];
  if (!accessToken && !refreshToken) return { user: null, session: null, refreshed: false };

  let result = accessToken ? await providerRequest("/auth/v1/user", { accessToken }) : { ok: false };
  let session = null;
  let refreshed = false;
  if (!result.ok && refreshToken) {
    session = await refreshSession(refreshToken);
    if (session?.access_token) {
      accessToken = session.access_token;
      refreshed = true;
      result = await providerRequest("/auth/v1/user", { accessToken });
    }
  }
  if (!result.ok) return { user: null, session: null, refreshed: false };
  return { user: result.data, session, refreshed };
}

const RATE_LIMITS = {
  register: [
    ["ip", 5, 3600],
    ["email", 4, 3600],
  ],
  login: [
    ["ip", 15, 900],
    ["email", 8, 900],
  ],
  verify: [["email", 5, 600]],
  resend: [
    ["email_cooldown", 1, 60],
    ["email", 3, 3600],
    ["ip", 15, 3600],
  ],
  forgot: [
    ["ip", 5, 3600],
    ["email", 3, 3600],
  ],
  reset: [["ip", 10, 3600]],
  changePassword: [["ip", 10, 3600]],
};

async function consumeRateLimit(key, limit, windowSeconds) {
  const response = await providerRequest("/rest/v1/rpc/consume_auth_rate_limit", {
    method: "POST",
    body: { p_key: key, p_limit: limit, p_window_seconds: windowSeconds },
    useServiceRole: true,
  });
  if (!response.ok) {
    throw new ConfigError("The distributed rate-limit store is unavailable.");
  }
  const allowed = response.data === true || response.data?.allowed === true;
  if (!allowed) {
    throw new HttpError(429, "Too many attempts. Please wait and try again.", "rate_limited");
  }
}

async function enforceRateLimit(req, action, email = "") {
  const config = getConfig();
  const entries = RATE_LIMITS[action] || [];
  for (const [scope, limit, windowSeconds] of entries) {
    const raw = scope.startsWith("email") ? `email:${email}` : `ip:${getClientIp(req)}`;
    const key = `${action}:${scope}:${hashIdentifier(raw, config.authSecret)}`;
    await consumeRateLimit(key, limit, windowSeconds);
  }
}

function requireEmail(value) {
  const email = normalizeEmail(value);
  if (!isValidEmail(email)) {
    throw new HttpError(400, "Enter a valid email address.", "invalid_email");
  }
  return email;
}

function requirePassword(value) {
  const error = validatePassword(value);
  if (error) throw new HttpError(400, error, "invalid_password");
  return value;
}

function requireCode(value) {
  if (typeof value !== "string" || !/^\d{6}$/.test(value.trim())) {
    throw new HttpError(400, "Enter the 6-digit verification code.", "invalid_code");
  }
  return value.trim();
}

function requireTokenHash(value) {
  if (typeof value !== "string" || value.length < 20 || value.length > 512 || !/^[A-Za-z0-9._~-]+$/.test(value)) {
    throw new HttpError(400, "That recovery link is invalid or expired.", "invalid_recovery_link");
  }
  return value;
}

async function register(req, res) {
  const body = await readJson(req);
  const email = requireEmail(body.email);
  const password = requirePassword(body.password);
  if (body.passwordConfirmation !== body.password) {
    throw new HttpError(400, "Passwords do not match.", "password_mismatch");
  }
  await enforceRateLimit(req, "register", email);
  const result = await providerRequest("/auth/v1/signup", { method: "POST", body: { email, password } });
  if (!result.ok && result.status >= 500) throw new ConfigError("The authentication provider is unavailable.");
  if (!result.ok && result.status !== 400 && result.status !== 422) {
    throw new HttpError(502, GENERIC_MESSAGE, "provider_error");
  }

  const session = result.data?.session;
  if (session?.access_token && result.data?.user?.email_confirmed_at) {
    setSessionCookies(res, session);
    return sendJson(res, 200, { status: "active", user: userPayload(result.data.user) });
  }
  return sendJson(res, 200, {
    status: "pending_verification",
    email,
    maskedEmail: maskEmail(email),
  });
}

async function login(req, res) {
  const body = await readJson(req);
  const email = requireEmail(body.email);
  if (typeof body.password !== "string" || !body.password) {
    throw new HttpError(400, "Enter your password.", "invalid_password");
  }
  await enforceRateLimit(req, "login", email);
  const result = await providerRequest("/auth/v1/token?grant_type=password", {
    method: "POST",
    body: { email, password: body.password },
  });
  if (!result.ok) {
    if (providerMessage(result).includes("not confirmed")) {
      return sendJson(res, 403, { error: "Confirm your email before signing in.", code: "email_not_verified" });
    }
    return sendJson(res, 401, { error: "Email or password is incorrect.", code: "invalid_credentials" });
  }
  setSessionCookies(res, result.data);
  return sendJson(res, 200, { status: "active", user: userPayload(result.data.user) });
}

async function verifyEmail(req, res) {
  const body = await readJson(req);
  const email = requireEmail(body.email);
  const token = requireCode(body.code);
  await enforceRateLimit(req, "verify", email);
  const result = await providerRequest("/auth/v1/verify", {
    method: "POST",
    body: { type: "email", email, token },
  });
  if (!result.ok || !result.data?.session) {
    return sendJson(res, 400, { error: "That code is invalid or expired.", code: "invalid_code" });
  }
  setSessionCookies(res, result.data.session);
  return sendJson(res, 200, { status: "active", user: userPayload(result.data.user) });
}

async function resendCode(req, res) {
  const body = await readJson(req);
  const email = requireEmail(body.email);
  await enforceRateLimit(req, "resend", email);
  const result = await providerRequest("/auth/v1/resend", {
    method: "POST",
    body: { type: "signup", email },
  });
  if (!result.ok && result.status >= 500) throw new ConfigError("The authentication provider is unavailable.");
  return sendJson(res, 200, { status: "sent", message: "If the account can receive a code, a new one is on its way." });
}

async function session(req, res) {
  const loaded = await loadSession(req);
  if (loaded.refreshed) setSessionCookies(res, loaded.session);
  if (!loaded.user && (parseCookies(req)[ACCESS_COOKIE] || parseCookies(req)[REFRESH_COOKIE])) {
    clearSessionCookies(res);
  }
  return sendJson(res, 200, {
    authenticated: Boolean(loaded.user),
    user: userPayload(loaded.user),
  });
}

async function logout(req, res) {
  const cookies = parseCookies(req);
  if (cookies[ACCESS_COOKIE]) {
    await providerRequest("/auth/v1/logout", { method: "POST", accessToken: cookies[ACCESS_COOKIE] });
  }
  clearSessionCookies(res);
  return sendJson(res, 200, { status: "signed_out" });
}

async function forgotPassword(req, res) {
  const body = await readJson(req);
  const email = requireEmail(body.email);
  await enforceRateLimit(req, "forgot", email);
  const config = getConfig();
  const result = await providerRequest("/auth/v1/recover", {
    method: "POST",
    body: { email, redirect_to: `${config.appBaseUrl}/home.html?auth=recovery` },
  });
  if (!result.ok && result.status >= 500) throw new ConfigError("The authentication provider is unavailable.");
  return sendJson(res, 200, { status: "sent", message: GENERIC_EMAIL_MESSAGE });
}

async function verifyRecovery(req, res) {
  const body = await readJson(req);
  const tokenHash = requireTokenHash(body.tokenHash);
  const result = await providerRequest("/auth/v1/verify", {
    method: "POST",
    body: { type: "recovery", token_hash: tokenHash },
  });
  if (!result.ok || !result.data?.session) {
    return sendJson(res, 400, { error: "That recovery link is invalid or expired.", code: "invalid_recovery_link" });
  }
  setSessionCookies(res, result.data.session);
  return sendJson(res, 200, { status: "ready" });
}

async function getAuthenticatedUser(req) {
  const loaded = await loadSession(req);
  if (!loaded.user || !loaded.session && !parseCookies(req)[ACCESS_COOKIE]) {
    throw new HttpError(401, "Your session has expired. Please sign in again.", "unauthenticated");
  }
  return loaded;
}

async function updatePassword(req, res, { requireCurrentPassword }) {
  const body = await readJson(req);
  const password = requirePassword(body.password);
  if (body.passwordConfirmation !== body.password) {
    throw new HttpError(400, "Passwords do not match.", "password_mismatch");
  }
  const loaded = await getAuthenticatedUser(req);
  const cookies = parseCookies(req);
  const accessToken = loaded.session?.access_token || cookies[ACCESS_COOKIE];
  const updateBody = { password };
  if (requireCurrentPassword) {
    if (typeof body.currentPassword !== "string" || !body.currentPassword) {
      throw new HttpError(400, "Enter your current password.", "invalid_current_password");
    }
    updateBody.current_password = body.currentPassword;
  }
  const result = await providerRequest("/auth/v1/user", {
    method: "PUT",
    body: updateBody,
    accessToken,
  });
  if (!result.ok) {
    if (providerMessage(result).includes("password")) {
      return sendJson(res, 400, { error: "The current password is incorrect or the new password is not accepted.", code: "password_update_failed" });
    }
    throw new HttpError(502, GENERIC_MESSAGE, "provider_error");
  }
  if (requireCurrentPassword) {
    await providerRequest("/auth/v1/logout", { method: "POST", accessToken });
  }
  clearSessionCookies(res);
  return sendJson(res, 200, { status: "password_changed" });
}

async function resetPassword(req, res) {
  await enforceRateLimit(req, "reset");
  return updatePassword(req, res, { requireCurrentPassword: false });
}

async function changePassword(req, res) {
  await enforceRateLimit(req, "changePassword");
  return updatePassword(req, res, { requireCurrentPassword: true });
}

async function route(req, res) {
  const action = String(req.query?.action || "").toLowerCase();
  const mutating = new Set(["register", "login", "verify-email", "resend-code", "logout", "forgot-password", "verify-recovery", "reset-password", "change-password"]);
  try {
    if (req.method === "OPTIONS") {
      assertSameOrigin(req);
      res.setHeader("Allow", "GET, POST, OPTIONS");
      return sendJson(res, 204, {});
    }
    if (mutating.has(action)) assertSameOrigin(req);
    if (action === "session" && req.method === "GET") return await session(req, res);
    if (action === "register" && req.method === "POST") return await register(req, res);
    if (action === "login" && req.method === "POST") return await login(req, res);
    if (action === "verify-email" && req.method === "POST") return await verifyEmail(req, res);
    if (action === "resend-code" && req.method === "POST") return await resendCode(req, res);
    if (action === "logout" && req.method === "POST") return await logout(req, res);
    if (action === "forgot-password" && req.method === "POST") return await forgotPassword(req, res);
    if (action === "verify-recovery" && req.method === "POST") return await verifyRecovery(req, res);
    if (action === "reset-password" && req.method === "POST") return await resetPassword(req, res);
    if (action === "change-password" && req.method === "POST") return await changePassword(req, res);
    return methodNotAllowed(res, action === "session" ? ["GET"] : ["POST"]);
  } catch (error) {
    return sendError(res, error);
  }
}

module.exports = {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  ConfigError,
  GENERIC_EMAIL_MESSAGE,
  GENERIC_MESSAGE,
  HttpError,
  isValidEmail,
  maskEmail,
  normalizeEmail,
  parseCookies,
  route,
  validatePassword,
};
