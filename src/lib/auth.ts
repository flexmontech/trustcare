/**
 * Trust Care Agency — $0 team sign-on (SERVER-SIDE ONLY).
 *
 * ONE shared password for the whole team: no usernames, no email, no roles,
 * no reset flow, no account list. Three people type one password once and stay
 * signed in for 30 days. Everything here is built-in `node:crypto` + a JSON
 * file on disk — no external auth service, no paid anything, no new deps.
 *
 * Files (never served to the browser — `data/` is not a static dir):
 *   <site>/data/auth.json        scrypt hash + salt + KDF params (mode 0600)
 *   <site>/data/.session-secret  random HMAC key, created once if
 *                                SESSION_SECRET is not set in the environment
 *
 * The plaintext password never leaves the request that carried it: it is not
 * logged, echoed, stored, or returned by any function in this module.
 *
 * NEVER import this module from client code — node:crypto/node:fs only run on
 * the server (API route handlers + createServerFn handlers).
 */
import {
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

/* -------------------------------------------------------------------------- */
/*  Paths                                                                     */
/* -------------------------------------------------------------------------- */

const KNOWN_SITE_DIR = "/home/team/shared/site";

function detectSiteDir(): string {
  const cwd = process.cwd();
  try {
    if (existsSync(join(cwd, "src", "lib", "auth.ts"))) return cwd;
    if (existsSync(join(cwd, "package.json")) && existsSync(join(cwd, "src")))
      return cwd;
  } catch {
    // fall through
  }
  return KNOWN_SITE_DIR;
}

const SITE_DIR = detectSiteDir();
const DATA_DIR = process.env.AUTH_DATA_DIR ?? join(SITE_DIR, "data");
const AUTH_FILE = process.env.AUTH_FILE ?? join(DATA_DIR, "auth.json");
const SECRET_FILE =
  process.env.SESSION_SECRET_FILE ?? join(DATA_DIR, ".session-secret");

/* -------------------------------------------------------------------------- */
/*  Password record (scrypt)                                                  */
/* -------------------------------------------------------------------------- */

/** scrypt cost parameters. N=16384,r=8,p=1 → ~16MB, ~50ms on a small box. */
const KDF = {
  name: "scrypt",
  cost: 16384, // N
  blockSize: 8, // r
  parallelization: 1, // p
  keylen: 64, // bytes of derived key
} as const;

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;

interface AuthRecord {
  version: 1;
  kdf: "scrypt";
  salt: string; // hex, 16 random bytes
  hash: string; // hex, scrypt output (keylen bytes)
  keylen: number;
  cost: number;
  blockSize: number;
  parallelization: number;
  created_at: string;
  updated_at: string;
}

function readAuthFile(): AuthRecord | null {
  try {
    if (!existsSync(AUTH_FILE)) return null;
    const raw = readFileSync(AUTH_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<AuthRecord>;
    if (
      typeof parsed?.hash !== "string" ||
      typeof parsed?.salt !== "string" ||
      parsed.hash.length === 0 ||
      parsed.salt.length === 0
    )
      return null;
    return {
      version: 1,
      kdf: "scrypt",
      salt: parsed.salt,
      hash: parsed.hash,
      keylen: parsed.keylen ?? KDF.keylen,
      cost: parsed.cost ?? KDF.cost,
      blockSize: parsed.blockSize ?? KDF.blockSize,
      parallelization: parsed.parallelization ?? KDF.parallelization,
      created_at: parsed.created_at ?? new Date().toISOString(),
      updated_at: parsed.updated_at ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/** Write a small JSON file, owner-read/write only (mode 0600), atomically. */
function writePrivateJson(file: string, value: unknown): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const data = JSON.stringify(value, null, 2);
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  // rename is atomic on the same filesystem
  renameSync(tmp, file);
}

function derive(password: string, saltHex: string, keylen: number): Buffer {
  return scryptSync(password.normalize("NFKC"), Buffer.from(saltHex, "hex"), keylen, {
    N: KDF.cost,
    r: KDF.blockSize,
    p: KDF.parallelization,
    maxmem: 64 * 1024 * 1024,
  });
}

function hashPassword(password: string): AuthRecord {
  const salt = randomBytes(16).toString("hex");
  const hash = derive(password, salt, KDF.keylen);
  const now = new Date().toISOString();
  const previous = readAuthFile();
  return {
    version: 1,
    kdf: "scrypt",
    salt,
    hash: hash.toString("hex"),
    keylen: KDF.keylen,
    cost: KDF.cost,
    blockSize: KDF.blockSize,
    parallelization: KDF.parallelization,
    created_at: previous?.created_at ?? now,
    updated_at: now,
  };
}

/** True once the owner has set the team password (the only account state). */
export function isPasswordSet(): boolean {
  return readAuthFile() !== null;
}

/** Plain-English password rules (kept intentionally loose & non-technical). */
export function checkPasswordShape(password: unknown): string | null {
  if (typeof password !== "string" || password.length === 0)
    return "Please enter the team password.";
  if (password.length < MIN_PASSWORD_LENGTH)
    return `Please use at least ${String(MIN_PASSWORD_LENGTH)} characters.`;
  if (password.length > MAX_PASSWORD_LENGTH)
    return "That password is too long — please use 200 characters or fewer.";
  return null;
}

/**
 * First-run only: set the team password. Returns false when a password
 * already exists — this path can never overwrite an existing one.
 */
export function setInitialPassword(password: string): boolean {
  if (isPasswordSet()) return false;
  writePrivateJson(AUTH_FILE, hashPassword(password));
  return true;
}

/** Check a typed password against the stored scrypt hash (constant-time). */
export function verifyPassword(password: string): boolean {
  const record = readAuthFile();
  if (!record) return false;
  const expected = Buffer.from(record.hash, "hex");
  const actual = derive(
    password.normalize("NFKC"),
    record.salt,
    record.keylen || KDF.keylen,
  );
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** Signed-in users only: change the shared password. */
export function changePassword(current: string, next: string): boolean {
  const record = readAuthFile();
  if (!record) return false;
  if (!verifyPassword(current)) return false;
  writePrivateJson(AUTH_FILE, hashPassword(next));
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Session cookie (signed, HttpOnly, SameSite=Lax, 30 days)                   */
/* -------------------------------------------------------------------------- */

export const SESSION_COOKIE = "tc_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

/** HMAC key: SESSION_SECRET from env, else a random key persisted in data/. */
function getSessionSecret(): Buffer {
  const fromEnv = process.env.SESSION_SECRET;
  if (typeof fromEnv === "string" && fromEnv.trim().length >= 16)
    return createHash("sha256").update(fromEnv.trim()).digest();

  try {
    if (existsSync(SECRET_FILE)) {
      const raw = readFileSync(SECRET_FILE, "utf8").trim();
      if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
    }
  } catch {
    // fall through and regenerate
  }

  const secret = randomBytes(32).toString("hex");
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const fd = openSync(SECRET_FILE, "w", 0o600);
  try {
    writeSync(fd, secret);
  } finally {
    closeSync(fd);
  }
  return Buffer.from(secret, "hex");
}

/**
 * Short tag derived from the stored password hash, signed into every session.
 * Changing the password therefore signs everyone out automatically.
 */
function passwordTag(): string {
  const record = readAuthFile();
  if (!record) return "none";
  return createHash("sha256").update(record.hash).digest("hex").slice(0, 16);
}

function sign(payload: string): string {
  return createHmac("sha256", getSessionSecret()).update(payload).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Build a signed session token valid until `expiresAt` (epoch seconds). */
export function createSessionToken(
  expiresAt: number = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS,
): string {
  const payload = `v1.${String(expiresAt)}.${passwordTag()}`;
  return `${payload}.${sign(payload)}`;
}

/** True when the token is well-formed, unexpired, and signed by us. */
export function verifySessionToken(token: string | undefined | null): boolean {
  if (typeof token !== "string" || token.length === 0 || token.length > 512)
    return false;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return false;
  const [, expiresRaw, tag, signature] = parts;
  const expiresAt = Number(expiresRaw);
  if (!Number.isInteger(expiresAt)) return false;
  if (expiresAt <= Math.floor(Date.now() / 1000)) return false;
  const payload = `v1.${expiresRaw}.${tag}`;
  if (!safeEqualHex(signature, sign(payload))) return false;
  return safeEqualHex(tag, passwordTag());
}

/* ---- cookie helpers (plain strings, usable in any Response) -------------- */

function cookieAttributes(request?: Request): string {
  const proto =
    request?.headers.get("x-forwarded-proto") ??
    (request ? new URL(request.url).protocol.replace(":", "") : "https");
  const secure = proto.split(",")[0]?.trim() === "https" ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Lax${secure}`;
}

/** Set-Cookie value that signs the browser in for 30 days. */
export function sessionCookieValue(request?: Request): string {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS;
  const token = createSessionToken(expiresAt);
  const expires = new Date(expiresAt * 1000).toUTCString();
  return `${SESSION_COOKIE}=${token}; ${cookieAttributes(request)}; Max-Age=${String(
    SESSION_MAX_AGE_SECONDS,
  )}; Expires=${expires}`;
}

/** Set-Cookie value that signs the browser out. */
export function clearedSessionCookieValue(request?: Request): string {
  return `${SESSION_COOKIE}=; ${cookieAttributes(request)}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

/** Read our session cookie out of a raw Cookie header. */
export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE)
      return part.slice(eq + 1).trim();
  }
  return null;
}

/** The one check every protected page and API route uses. */
export function isAuthenticatedRequest(request: Request): boolean {
  return verifySessionToken(readSessionCookie(request));
}

/* -------------------------------------------------------------------------- */
/*  Brute-force guard (in-memory, per client IP)                              */
/* -------------------------------------------------------------------------- */

const MAX_ATTEMPTS = 5;
const LOCK_MS = 10 * 60 * 1000; // 10 minutes
const MAX_TRACKED_IPS = 2000;

interface Attempt {
  count: number;
  lockedUntil: number;
}

const attempts = new Map<string, Attempt>();

export function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

function pruneAttempts(now: number): void {
  if (attempts.size <= MAX_TRACKED_IPS) return;
  for (const [ip, entry] of attempts)
    if (entry.lockedUntil <= now && entry.count === 0) attempts.delete(ip);
}

/** Minutes left on an active lockout, or 0 when not locked out. */
export function lockoutMinutes(ip: string): number {
  const entry = attempts.get(ip);
  if (!entry || entry.lockedUntil <= Date.now()) return 0;
  return Math.max(1, Math.ceil((entry.lockedUntil - Date.now()) / 60000));
}

/**
 * Record a wrong password. After MAX_ATTEMPTS in a row from one IP the IP is
 * locked out for LOCK_MS. Returns the remaining lockout in minutes (0 = none).
 */
export function recordFailedAttempt(ip: string): number {
  const now = Date.now();
  pruneAttempts(now);
  const entry = attempts.get(ip) ?? { count: 0, lockedUntil: 0 };
  if (entry.lockedUntil > now) return lockoutMinutes(ip);
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.count = 0;
    entry.lockedUntil = now + LOCK_MS;
    attempts.set(ip, entry);
    return lockoutMinutes(ip);
  }
  attempts.set(ip, entry);
  return 0;
}

/** A correct sign-in (or a successful password change) clears the counter. */
export function clearFailedAttempts(ip: string): void {
  attempts.delete(ip);
}

/* -------------------------------------------------------------------------- */
/*  Small JSON helpers for the auth API routes                                */
/* -------------------------------------------------------------------------- */

export const LOCKOUT_MESSAGE =
  "Too many attempts. Please try again in 10 minutes.";

export function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  setCookie?: string,
): Response {
  const headers = new Headers({ "content-type": "application/json" });
  headers.set("cache-control", "no-store");
  if (setCookie) headers.append("set-cookie", setCookie);
  return new Response(JSON.stringify(body), { status, headers });
}

export function unauthenticated(): Response {
  return jsonResponse(
    { error: "Please sign in with the team password." },
    401,
  );
}

/** Guard helper for API routes: a 401 Response, or null when signed in. */
export function requireAuth(request: Request): Response | null {
  return isAuthenticatedRequest(request) ? null : unauthenticated();
}
