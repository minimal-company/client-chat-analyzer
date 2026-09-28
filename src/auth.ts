import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DATA_DIR } from "./config.js";

// ---------------------------------------------------------------------------
// Usuarios y sesiones de la interfaz web. Todo vive en DATA_DIR:
//   users.json     usuarios con la contraseña en scrypt (nunca en claro)
//   sessions.json  sesiones abiertas; se guarda el hash del token, no el token
// La CLI (`cca user ...`) edita users.json en otro contenedor: el servidor lo relee cuando cambia.
// ---------------------------------------------------------------------------

const USERS_FILE = resolve(DATA_DIR, "users.json");
const SESSIONS_FILE = resolve(DATA_DIR, "sessions.json");

/** Una sesión sin uso vence a los 7 días; con uso se renueva, pero nunca dura más de 30. */
const SESSION_IDLE_MS = 7 * 24 * 3600 * 1000;
const SESSION_MAX_MS = 30 * 24 * 3600 * 1000;
export const SESSION_COOKIE = "cca_session";
export const MIN_PASSWORD = 10;

/** admin: todo, incluido el Panel de control. analista: clientes y conversaciones con la IA. */
export type Role = "admin" | "analista";
export const ROLES: Role[] = ["admin", "analista"];

export interface User {
  username: string;
  name: string;
  hash: string;
  role?: Role; // sin rol = admin (usuarios creados antes de que existieran los roles)
  mustChangePassword?: boolean;
  createdAt: number;
  lastLoginAt?: number;
  /** Las sesiones abiertas antes de esto dejan de valer (cambio o reinicio de contraseña). */
  sessionsValidAfter: number;
}

interface Session {
  id: string; // sha256 del token de la cookie
  username: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt?: number;
  ip: string;
  userAgent: string;
}

export interface PublicUser {
  username: string;
  name: string;
  role: Role;
  mustChangePassword: boolean;
}

export const roleOf = (u: User): Role => u.role ?? "admin";
export const publicUser = (u: User): PublicUser => ({ username: u.username, name: u.name, role: roleOf(u), mustChangePassword: !!u.mustChangePassword });

// ---------- contraseñas ----------

const SCRYPT = { N: 2 ** 16, r: 8, p: 1, keylen: 64 };

function scryptAsync(password: string, salt: Buffer, N: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((ok, fail) =>
    scrypt(password.normalize("NFKC"), salt, keylen, { N, r, p, maxmem: 256 * N * r }, (err, key) => (err ? fail(err) : ok(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keylen);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, key] = stored.split("$");
  if (kind !== "scrypt" || !key) return false;
  const expected = Buffer.from(key, "base64");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p), expected.length);
  return timingSafeEqual(actual, expected);
}

/** Para usuarios inexistentes se calcula igual un hash: la demora no delata qué usuarios existen. */
let dummyHash: Promise<string> | null = null;

export function passwordProblem(password: unknown, username?: string): string | null {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) return `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`;
  if (password.length > 200) return "La contraseña es demasiado larga.";
  if (username && password.toLowerCase() === username.toLowerCase()) return "La contraseña no puede ser igual al usuario.";
  return null;
}

/** Contraseña temporal legible (sin 0/O, 1/l): 4 grupos de 4. */
export function temporaryPassword(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(16);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join("")).join("-");
}

// ---------- archivos ----------

async function writeAtomic(file: string, data: unknown) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}

let usersCache: { mtimeMs: number; users: User[] } | null = null;

export async function loadUsers(): Promise<User[]> {
  const info = await stat(USERS_FILE).catch(() => null);
  if (!info) return [];
  if (usersCache?.mtimeMs === info.mtimeMs) return usersCache.users;
  const users = (JSON.parse(await readFile(USERS_FILE, "utf-8")).users ?? []) as User[];
  usersCache = { mtimeMs: info.mtimeMs, users };
  return users;
}

export async function saveUsers(users: User[]) {
  await writeAtomic(USERS_FILE, { users });
  usersCache = null;
}

export const normalizeUsername = (s: unknown) => (typeof s === "string" ? s.trim().toLowerCase() : "");
export const validUsername = (s: string) => /^[a-z0-9][a-z0-9._@-]{1,63}$/.test(s);

async function findUser(username: string): Promise<User | undefined> {
  return (await loadUsers()).find((u) => u.username === username);
}

/**
 * Primer arranque: si todavía no hay usuarios, se crea uno con WEB_USER / WEB_PASSWORD (las credenciales
 * que ya se usaban) y se le exige cambiar la contraseña al entrar.
 */
export async function ensureBootstrapUser(username: string, password: string | null): Promise<string | null> {
  if ((await loadUsers()).length) return null;
  if (!password) throw new Error("No hay usuarios: defina WEB_PASSWORD en .env o cree uno con `cca user add <usuario>`.");
  const name = normalizeUsername(username) || "admin";
  const now = Date.now();
  await saveUsers([{ username: name, name: "Administrador", hash: await hashPassword(password), role: "admin", mustChangePassword: true, createdAt: now, sessionsValidAfter: now }]);
  return name;
}

// ---------- administración de usuarios (Panel de control y CLI) ----------

const admins = (users: User[]) => users.filter((u) => roleOf(u) === "admin");

/** Crea un usuario con contraseña temporal (se pide cambiarla al ingresar). Devuelve esa contraseña. */
export async function addUser(usernameRaw: unknown, nameRaw: unknown, role: Role): Promise<string> {
  const username = normalizeUsername(usernameRaw);
  if (!validUsername(username)) throw new AuthError(400, "Usuario inválido: de 2 a 64 caracteres, en minúsculas, con números y . _ @ -");
  if (!ROLES.includes(role)) throw new AuthError(400, "Rol inválido.");
  const users = await loadUsers();
  if (users.some((u) => u.username === username)) throw new AuthError(409, `El usuario "${username}" ya existe.`);
  const password = temporaryPassword();
  const now = Date.now();
  const name = typeof nameRaw === "string" && nameRaw.trim() ? nameRaw.trim().slice(0, 80) : username;
  await saveUsers([...users, { username, name, hash: await hashPassword(password), role, mustChangePassword: true, createdAt: now, sessionsValidAfter: now }]);
  return password;
}

/** Nueva contraseña temporal; cierra las sesiones abiertas de ese usuario. */
export async function resetUserPassword(username: string): Promise<string> {
  const users = await loadUsers();
  const user = users.find((u) => u.username === username);
  if (!user) throw new AuthError(404, `No existe el usuario "${username}".`);
  const password = temporaryPassword();
  user.hash = await hashPassword(password);
  user.mustChangePassword = true;
  user.sessionsValidAfter = Date.now();
  await saveUsers(users);
  await dropSessions((s) => s.username === username);
  return password;
}

export async function updateUser(username: string, changes: { name?: unknown; role?: unknown }) {
  const users = await loadUsers();
  const user = users.find((u) => u.username === username);
  if (!user) throw new AuthError(404, `No existe el usuario "${username}".`);
  if (changes.role !== undefined) {
    if (!ROLES.includes(changes.role as Role)) throw new AuthError(400, "Rol inválido.");
    if (roleOf(user) === "admin" && changes.role !== "admin" && admins(users).length === 1) {
      throw new AuthError(400, "Es el único administrador: nombre otro antes de quitarle el rol.");
    }
    user.role = changes.role as Role;
  }
  if (typeof changes.name === "string" && changes.name.trim()) user.name = changes.name.trim().slice(0, 80);
  await saveUsers(users);
}

export async function removeUser(username: string) {
  const users = await loadUsers();
  const user = users.find((u) => u.username === username);
  if (!user) throw new AuthError(404, `No existe el usuario "${username}".`);
  if (roleOf(user) === "admin" && admins(users).length === 1) throw new AuthError(400, "Es el único administrador: nombre otro antes de borrarlo.");
  await saveUsers(users.filter((u) => u !== user));
  await dropSessions((s) => s.username === username);
}

export async function listUsers() {
  return (await loadUsers()).map((u) => ({ ...publicUser(u), createdAt: u.createdAt, lastLoginAt: u.lastLoginAt ?? null }));
}

export async function recordLogin(username: string) {
  const users = await loadUsers();
  const user = users.find((u) => u.username === username);
  if (!user) return;
  user.lastLoginAt = Date.now();
  await saveUsers(users);
}

// ---------- registro de ingresos ----------

const AUTH_LOG_FILE = resolve(DATA_DIR, "auth-log.json");
const AUTH_LOG_MAX = 300;
export interface AuthEvent {
  at: number;
  username: string;
  ip: string;
  result: "ok" | "fail" | "blocked";
  userAgent?: string;
}
let authLogWrite: Promise<unknown> = Promise.resolve();

export function logAuthEvent(event: AuthEvent) {
  authLogWrite = authLogWrite
    .then(async () => {
      const raw = await readFile(AUTH_LOG_FILE, "utf-8").catch(() => null);
      const events = raw ? ((JSON.parse(raw).events ?? []) as AuthEvent[]) : [];
      events.push({ ...event, username: event.username.slice(0, 64), userAgent: event.userAgent?.slice(0, 200) });
      await writeAtomic(AUTH_LOG_FILE, { events: events.slice(-AUTH_LOG_MAX) });
    })
    .catch((err) => console.error("[auth] no se pudo guardar el registro de ingresos:", err));
}

export async function recentAuthEvents(limit = 50): Promise<AuthEvent[]> {
  await authLogWrite;
  const raw = await readFile(AUTH_LOG_FILE, "utf-8").catch(() => null);
  return raw ? ((JSON.parse(raw).events ?? []) as AuthEvent[]).slice(-limit).reverse() : [];
}

// ---------- inicio de sesión ----------

export async function verifyLogin(usernameRaw: unknown, password: unknown): Promise<User | null> {
  const username = normalizeUsername(usernameRaw);
  if (typeof password !== "string" || !password || password.length > 200) return null;
  const user = username ? await findUser(username) : undefined;
  if (!user) {
    dummyHash ??= hashPassword(randomBytes(12).toString("hex"));
    await verifyPassword(password, await dummyHash);
    return null;
  }
  return (await verifyPassword(password, user.hash)) ? user : null;
}

export async function changePassword(username: string, current: unknown, next: unknown, keepSessionToken?: string): Promise<void> {
  const users = await loadUsers();
  const user = users.find((u) => u.username === username);
  if (!user) throw new AuthError(404, "El usuario ya no existe.");
  if (typeof current !== "string" || !(await verifyPassword(current, user.hash))) throw new AuthError(400, "La contraseña actual no es correcta.");
  const problem = passwordProblem(next, username);
  if (problem) throw new AuthError(400, problem);
  if (next === current) throw new AuthError(400, "La contraseña nueva debe ser distinta de la actual.");
  const now = Date.now();
  user.hash = await hashPassword(next as string);
  user.mustChangePassword = false;
  user.sessionsValidAfter = now;
  await saveUsers(users);
  // Las demás sesiones quedan cerradas; la de quien hizo el cambio sigue abierta.
  await dropSessions((s) => s.username === username && (!keepSessionToken || s.id !== tokenId(keepSessionToken)));
  if (keepSessionToken) {
    const own = (await loadSessions()).find((s) => s.id === tokenId(keepSessionToken));
    if (own) {
      own.createdAt = now;
      await persistSessions();
    }
  }
}

export class AuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------- sesiones ----------

let sessions: Session[] | null = null;
let persistTimer: NodeJS.Timeout | null = null;

async function loadSessions(): Promise<Session[]> {
  if (!sessions) {
    const raw = await readFile(SESSIONS_FILE, "utf-8").catch(() => null);
    sessions = raw ? ((JSON.parse(raw).sessions ?? []) as Session[]) : [];
  }
  return sessions;
}

async function persistSessions() {
  const now = Date.now();
  sessions = (await loadSessions()).filter((s) => s.expiresAt > now);
  await writeAtomic(SESSIONS_FILE, { sessions });
}

function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistSessions().catch((err) => console.error("[auth] no se pudieron guardar las sesiones:", err));
  }, 30_000);
  persistTimer.unref();
}

async function dropSessions(match: (s: Session) => boolean) {
  const all = await loadSessions();
  const kept = all.filter((s) => !match(s));
  if (kept.length !== all.length) {
    sessions = kept;
    await persistSessions();
  }
}

const tokenId = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createSession(user: User, ip: string, userAgent: string): Promise<{ token: string; maxAgeSec: number }> {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  (await loadSessions()).push({ id: tokenId(token), username: user.username, createdAt: now, expiresAt: now + SESSION_IDLE_MS, ip, userAgent: userAgent.slice(0, 200) });
  await persistSessions();
  return { token, maxAgeSec: SESSION_IDLE_MS / 1000 };
}

/** Devuelve el usuario de la sesión, o null si el token no existe, venció o el usuario cambió de contraseña. */
export async function sessionUser(token: string | undefined): Promise<{ user: User; maxAgeSec: number; renewed: boolean } | null> {
  if (!token || token.length > 100) return null;
  const now = Date.now();
  const session = (await loadSessions()).find((s) => s.id === tokenId(token));
  if (!session || session.expiresAt <= now) return null;
  const user = await findUser(session.username);
  if (!user || session.createdAt < user.sessionsValidAfter) return null;
  session.lastSeenAt = now;
  // Renovación deslizante, a lo sumo una vez por hora (evita escribir el archivo en cada pedido).
  const target = Math.min(now + SESSION_IDLE_MS, session.createdAt + SESSION_MAX_MS);
  const renewed = target - session.expiresAt > 3600 * 1000;
  if (renewed) {
    session.expiresAt = target;
    persistSoon();
  }
  return { user, maxAgeSec: Math.round((session.expiresAt - now) / 1000), renewed };
}

export async function endSession(token: string | undefined) {
  if (token) await dropSessions((s) => s.id === tokenId(token));
}

/** Sesiones vigentes, para el panel de Seguridad. `handle` identifica la sesión sin exponer el token. */
export async function listSessions(currentToken?: string) {
  const now = Date.now();
  const users = await loadUsers();
  const current = currentToken ? tokenId(currentToken) : "";
  return (await loadSessions())
    .filter((s) => s.expiresAt > now)
    .filter((s) => {
      const u = users.find((x) => x.username === s.username);
      return u && s.createdAt >= u.sessionsValidAfter;
    })
    .map((s) => ({
      handle: s.id.slice(0, 16),
      username: s.username,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt ?? s.createdAt,
      expiresAt: s.expiresAt,
      ip: s.ip,
      userAgent: s.userAgent,
      current: s.id === current,
    }))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

export async function closeSession(handle: string) {
  if (!/^[0-9a-f]{16}$/.test(handle)) throw new AuthError(400, "Sesión inválida.");
  await dropSessions((s) => s.id.startsWith(handle));
}

/** Cierra todas las sesiones menos la de quien lo pide. */
export async function closeOtherSessions(currentToken: string) {
  const keep = tokenId(currentToken);
  await dropSessions((s) => s.id !== keep);
}

// ---------- límite de intentos ----------

/**
 * Tras 5 intentos fallidos desde una IP (o 10 contra un mismo usuario) en 15 minutos, se bloquea hasta
 * que el más viejo salga de la ventana. Además, a lo sumo 4 verificaciones de contraseña a la vez: scrypt
 * es caro a propósito y no debe poder saturar el servidor.
 */
const WINDOW_MS = 15 * 60 * 1000;
const LIMITS = { ip: 5, user: 10 };
const failures = new Map<string, number[]>();
let verifying = 0;

function recent(key: string, now: number): number[] {
  const list = (failures.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length) failures.set(key, list);
  else failures.delete(key);
  return list;
}

/** Segundos que faltan para poder reintentar (0 = puede intentar). */
export function loginBlockedFor(ip: string, username: string): number {
  const now = Date.now();
  let wait = 0;
  for (const [key, limit] of [[`ip:${ip}`, LIMITS.ip], [`user:${username}`, LIMITS.user]] as const) {
    const list = recent(key, now);
    if (list.length >= limit) wait = Math.max(wait, list[list.length - limit] + WINDOW_MS - now);
  }
  return Math.ceil(wait / 1000);
}

export function recordLoginFailure(ip: string, username: string) {
  const now = Date.now();
  for (const key of [`ip:${ip}`, username ? `user:${username}` : null]) {
    if (key) failures.set(key, [...recent(key, now), now]);
  }
}

export function clearLoginFailures(ip: string, username: string) {
  failures.delete(`ip:${ip}`);
  failures.delete(`user:${username}`);
}

export async function withVerifySlot<T>(fn: () => Promise<T>): Promise<T> {
  if (verifying >= 4) throw new AuthError(503, "Hay demasiados intentos de ingreso en este momento. Intente de nuevo en unos segundos.");
  verifying++;
  try {
    return await fn();
  } finally {
    verifying--;
  }
}
