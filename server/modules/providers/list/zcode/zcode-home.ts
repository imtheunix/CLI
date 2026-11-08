import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/**
 * Per-job ZCode homes. ZCode keeps its session db (~/.zcode/cli/db/db.sqlite, SQLite WAL), logs and artifacts
 * under os.homedir(); concurrent processes sharing them die with "database is locked". Each app session therefore
 * runs ZCode with HOME set to its own shadow home:
 *
 *   <root>/<session>/zcode-home/
 *     <every top-level entry of the real home except .zcode>  -> symlink (git identity, ssh, ~/.cloudcli for tjob)
 *     .zcode/v2/{credentials.json,setting.json,certs}        -> symlink to the shared login files (never copied)
 *     .zcode/v2/provider_config.json                         -> private, written per turn by zcode-selection
 *     .zcode/cli/                                            -> private: db, logs, artifacts, rollout
 *     .zcode/cli/{plugins,memories}                          -> symlink to the shared ones
 *
 * The home is derived from the app session id, so a resumed conversation finds its own db again.
 */

const SHARED_V2 = ['credentials.json', 'setting.json', 'certs'];
const SHARED_CLI = ['plugins', 'memories', 'config.json'];

/** The real user home, read once: HOME is never changed in this process, only in ZCode's environment. */
export function realHome(): string {
  return os.homedir();
}

/** Root of the per-session ZCode homes; tests override it with ZCODE_JOB_HOMES_DIR. */
export function zcodeHomesRoot(): string {
  return process.env.ZCODE_JOB_HOMES_DIR?.trim() || path.join(realHome(), '.local', 'state', 'tribeira-jobs', 'zcode');
}

/** The ZCode home of one app session (not created). */
export function zcodeHomeFor(appSessionId: string): string {
  return path.join(zcodeHomesRoot(), encodeURIComponent(appSessionId), 'zcode-home');
}

function link(target: string, at: string): void {
  let current: string | null = null;
  try {
    const stat = lstatSync(at);
    if (!stat.isSymbolicLink()) return; // a private file or dir ZCode made itself stays private
    current = readlinkSync(at);
  } catch { /* missing */ }
  if (current === target) return;
  if (current !== null) unlinkSync(at);
  symlinkSync(target, at);
}

/**
 * Creates or refreshes a shadow home for ZCode and returns its path. Idempotent: run before every spawn so
 * login files or home entries that appeared since the last turn are linked too. Never reads the credentials.
 */
export function prepareZcodeHome(home: string, source: string = realHome()): string {
  const v2 = path.join(home, '.zcode', 'v2');
  const cli = path.join(home, '.zcode', 'cli');
  mkdirSync(v2, { recursive: true, mode: 0o700 });
  mkdirSync(cli, { recursive: true, mode: 0o700 });

  const resolvedHome = path.resolve(home);
  for (const entry of readdirSync(source)) {
    if (entry === '.zcode') continue;
    const target = path.join(source, entry);
    // Never link the tree that contains the shadow home into itself.
    if (resolvedHome === target || resolvedHome.startsWith(target + path.sep)) {
      // e.g. ~/.local holds ~/.local/state/tribeira-jobs: link its children instead, recursively.
      mirrorDir(target, path.join(home, entry), resolvedHome);
      continue;
    }
    link(target, path.join(home, entry));
  }

  for (const name of SHARED_V2) {
    const target = path.join(source, '.zcode', 'v2', name);
    if (existsSync(target)) link(target, path.join(v2, name));
  }
  for (const name of SHARED_CLI) {
    const target = path.join(source, '.zcode', 'cli', name);
    if (existsSync(target)) link(target, path.join(cli, name));
  }
  apiKeyLogin(home, source);
  return home;
}

/**
 * A linked credentials.json is not enough for a Z.ai Coding Plan API-key login: ZCode keeps the "manual login"
 * state in its own per-home store, so a fresh shadow home falls back to the browser-token exchange and gets a
 * 401 (2026-11-08). The first time a home still has the shared link, run the API-key login script inside it
 * (it reads the key file itself and writes a private credentials.json, which link() then keeps).
 * Skipped under tests and when the script is absent; a failure leaves the shared link as before.
 */
function apiKeyLogin(home: string, source: string): void {
  if (process.env.NODE_ENV === 'test') return;
  const creds = path.join(home, '.zcode', 'v2', 'credentials.json');
  try {
    if (!lstatSync(creds).isSymbolicLink()) return; // already logged in privately
  } catch { return; }
  const script = process.env.ZCODE_APIKEY_LOGIN_SCRIPT || path.join(source, '.local', 'share', 'zcode-login', 'login.cjs');
  if (!existsSync(script)) return;
  // The login only takes when the home already has a provider_config.json (model selection only, no secrets):
  // without it the manual-login state does not stick and the next turn 401s (verified 2026-11-08).
  const config = path.join(home, '.zcode', 'v2', 'provider_config.json');
  const sharedConfig = path.join(source, '.zcode', 'v2', 'provider_config.json');
  if (!existsSync(config) && existsSync(sharedConfig)) copyFileSync(sharedConfig, config);
  try {
    execFileSync(process.execPath, [script], { env: { ...process.env, HOME: home }, timeout: 60_000, stdio: 'ignore' });
  } catch (error) {
    console.warn('[zcode] API-key login in a shadow home failed; keeping the shared credentials link', error instanceof Error ? error.message : error);
  }
}

/** Mirrors a directory of the real home that contains the shadow home: a real dir whose other children are links. */
function mirrorDir(source: string, at: string, resolvedHome: string): void {
  try {
    if (lstatSync(at).isSymbolicLink()) unlinkSync(at);
  } catch { /* missing */ }
  mkdirSync(at, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(source)) {
    const target = path.join(source, entry);
    const here = path.join(at, entry);
    if (resolvedHome === target || resolvedHome.startsWith(target + path.sep)) {
      if (resolvedHome !== target) mirrorDir(target, here, resolvedHome);
      continue;
    }
    link(target, here);
  }
}

/** Environment for a ZCode child running in `home`. */
export function zcodeEnv(home: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, USERPROFILE: home };
}
