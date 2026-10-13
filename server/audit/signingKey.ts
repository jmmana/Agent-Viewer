import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { keyIdFor } from './checkpointFormat';

/**
 * Ed25519 checkpoint signing key (issue #387), resolved once at startup, in this order:
 *
 * 1. `AGENT_VIEWER_AUDIT_SIGNING_KEY`: a PKCS#8 PEM private key in the environment (a single-line value with
 *    literal `\n` escapes is accepted too, for env files that cannot hold newlines).
 * 2. `AGENT_VIEWER_AUDIT_KEY_FILE`: a path to such a PEM file. Generated there (mode 0600) when missing.
 * 3. Default: `audit-signing-key.pem` next to the SQLite file, generated (mode 0600) on first start.
 * 4. With `AGENT_VIEWER_SQLITE_PATH=:memory:` and neither variable set: an ephemeral in-memory key, with a
 *    warning, since nothing durable exists to sign for and no file should be written.
 *
 * Setting both variables is a startup error (ambiguous). A key that is not Ed25519, or a file that cannot be
 * parsed, is a startup error too, never a silent fallback to a generated key. No error or warning ever contains
 * key material.
 */

export const DEFAULT_KEY_FILENAME = 'audit-signing-key.pem';

export type SigningKeySource = 'env' | 'file' | 'generated' | 'ephemeral';

export interface LoadedSigningKey {
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
  /** SPKI PEM of the public key, exactly as stored in `audit_keys.public_key_pem`. */
  publicKeyPem: string;
  keyId: string;
  source: SigningKeySource;
  /** The key file actually used or written, or `null` for `env`/`ephemeral`. */
  filePath: string | null;
  warnings: string[];
}

export class SigningKeyError extends Error {
  readonly code = 'audit_signing_key_invalid';
  constructor(message: string) {
    super(message);
    this.name = 'SigningKeyError';
  }
}

function fromPrivateKey(privateKey: crypto.KeyObject, source: SigningKeySource, filePath: string | null, warnings: string[]): LoadedSigningKey {
  const publicKey = crypto.createPublicKey(privateKey);
  return {
    privateKey,
    publicKey,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    keyId: keyIdFor(publicKey),
    source,
    filePath,
    warnings,
  };
}

function parsePrivateKeyPem(pem: string, origin: string): crypto.KeyObject {
  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    throw new SigningKeyError(`${origin} is not a valid PEM private key.`);
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new SigningKeyError(`${origin} must be an Ed25519 private key (got ${key.asymmetricKeyType ?? 'unknown'}).`);
  }
  return key;
}

function generatePem(): string {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

/** Writes a fresh key with `O_CREAT | O_EXCL` and mode 0600, so it never overwrites an existing file and is never
 * world-readable, even briefly. Returns `false` when another process created the file first. */
function writeNewKeyFile(filePath: string, pem: string): boolean {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    fs.writeFileSync(fd, pem, { encoding: 'utf8' });
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (process.platform !== 'win32') fs.chmodSync(filePath, 0o600);
  return true;
}

function loadFromFile(filePath: string, warnings: string[]): LoadedSigningKey {
  if (!fs.existsSync(filePath)) {
    const pem = generatePem();
    if (writeNewKeyFile(filePath, pem)) {
      return fromPrivateKey(parsePrivateKeyPem(pem, 'The generated audit signing key'), 'generated', filePath, warnings);
    }
  }
  if (process.platform !== 'win32') {
    const mode = fs.statSync(filePath).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      warnings.push(`Audit signing key file ${filePath} is accessible by group/other (mode ${mode.toString(8)}); restrict it with chmod 600.`);
    }
  }
  let pem: string;
  try {
    pem = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new SigningKeyError(`Cannot read the audit signing key file ${filePath}: ${(error as NodeJS.ErrnoException).code ?? 'read error'}.`);
  }
  return fromPrivateKey(parsePrivateKeyPem(pem, `Audit signing key file ${filePath}`), 'file', filePath, warnings);
}

export interface LoadSigningKeyOptions {
  env: NodeJS.ProcessEnv;
  /** `AGENT_VIEWER_SQLITE_PATH` as the store resolved it (`EventStore.getDatabasePath()`). */
  dbPath: string;
}

export function loadSigningKey(options: LoadSigningKeyOptions): LoadedSigningKey {
  const warnings: string[] = [];
  const envPem = options.env.AGENT_VIEWER_AUDIT_SIGNING_KEY?.trim() || '';
  const envFile = options.env.AGENT_VIEWER_AUDIT_KEY_FILE?.trim() || '';
  if (envPem && envFile) {
    throw new SigningKeyError('Set only one of AGENT_VIEWER_AUDIT_SIGNING_KEY and AGENT_VIEWER_AUDIT_KEY_FILE.');
  }
  if (envPem) {
    const pem = envPem.includes('\n') ? envPem : envPem.replace(/\\n/g, '\n');
    return fromPrivateKey(parsePrivateKeyPem(pem, 'AGENT_VIEWER_AUDIT_SIGNING_KEY'), 'env', null, warnings);
  }
  if (envFile) return loadFromFile(path.resolve(envFile), warnings);
  if (options.dbPath === ':memory:' || options.dbPath === '') {
    warnings.push(
      'AGENT_VIEWER_SQLITE_PATH is :memory:; audit checkpoints are signed with an ephemeral key that is lost on exit. Set AGENT_VIEWER_AUDIT_SIGNING_KEY or AGENT_VIEWER_AUDIT_KEY_FILE to keep one.'
    );
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    return fromPrivateKey(privateKey, 'ephemeral', null, warnings);
  }
  return loadFromFile(path.join(path.dirname(path.resolve(options.dbPath)), DEFAULT_KEY_FILENAME), warnings);
}
