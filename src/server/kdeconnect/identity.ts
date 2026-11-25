// This device as other KDE Connect devices know it: its id, name and type, and the self-signed certificate whose
// common name is the id, kept in a file only its owner can read.

// ── Imports ──────────────────────────────────────────────────────────────────

import { createHash, webcrypto, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

// The certificate library needs the metadata polyfill loaded before it.
import "reflect-metadata";
import * as x509 from "@peculiar/x509";

import { clean_device_name, device_types, is_device_id, new_device_id, type DeviceType } from "../../shared/kdeconnect/packet.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface DeviceIdentity {
  device_id: string;
  name: string;
  type: DeviceType;
  certificate: string;
  private_key: string;
}

// ── Certificates ─────────────────────────────────────────────────────────────

const year_in_milliseconds = 365 * 24 * 60 * 60 * 1000;
const signing = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;

x509.cryptoProvider.set(webcrypto as never);

// A positive 20-byte serial, as RFC 5280 allows.
function random_serial(): string {
  const bytes = webcrypto.getRandomValues(new Uint8Array(20));
  bytes[0] = bytes[0]! & 0x7f;
  return Buffer.from(bytes).toString("hex");
}

function pem(label: string, der: ArrayBuffer): string {
  const lines = Buffer.from(der).toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

// An EC P-256 certificate valid from a year ago for ten years, as KDE Connect makes its own.
export async function make_certificate(device_id: string, now = new Date()): Promise<{ certificate: string; private_key: string }> {
  const keys = (await webcrypto.subtle.generateKey(signing, true, ["sign", "verify"])) as webcrypto.CryptoKeyPair;
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: random_serial(),
    name: `CN=${device_id}, O=KDE, OU=KDE Connect`,
    notBefore: new Date(now.getTime() - year_in_milliseconds),
    notAfter: new Date(now.getTime() + 10 * year_in_milliseconds),
    signingAlgorithm: signing,
    // Node's and the DOM's key types differ in name only, and the tests see both.
    keys: keys as never,
  });
  return { certificate: certificate.toString("pem"), private_key: pem("PRIVATE KEY", await webcrypto.subtle.exportKey("pkcs8", keys.privateKey)) };
}

// The common name a certificate carries, which a peer's must match its device id.
export function common_name_of(certificate: string | Buffer): string | null {
  const subject = new X509Certificate(certificate).subject;
  return /^CN=(.*)$/m.exec(subject)?.[1]?.trim() ?? null;
}

export function same_certificate(first: string | Buffer, second: string | Buffer): boolean {
  return new X509Certificate(first).fingerprint256 === new X509Certificate(second).fingerprint256;
}

export function fingerprint_of(certificate: string | Buffer): string {
  return new X509Certificate(certificate).fingerprint256;
}

// The code both screens show while pairing: both public keys, the larger first, then the request's time, hashed.
export function verification_key(own_certificate: string | Buffer, peer_certificate: string | Buffer, timestamp: number): string {
  let first = new X509Certificate(own_certificate).publicKey.export({ type: "spki", format: "der" });
  let second = new X509Certificate(peer_certificate).publicKey.export({ type: "spki", format: "der" });
  if (Buffer.compare(first, second) < 0) [first, second] = [second, first];
  return createHash("sha256").update(first).update(second).update(String(timestamp)).digest("hex").slice(0, 8).toUpperCase();
}

// ── Storage ──────────────────────────────────────────────────────────────────

function read_saved(file: string): Partial<DeviceIdentity> | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Partial<DeviceIdentity>;
  } catch {
    return null;
  }
}

export function save_identity(file: string, identity: DeviceIdentity): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(identity, null, 2), { mode: 0o600 });
}

// This device's identity from its file, made and saved the first time; a damaged file is replaced by a new identity.
export async function load_identity(file: string, defaults: { name?: string; type?: DeviceType } = {}): Promise<DeviceIdentity> {
  const saved = read_saved(file);
  if (saved && is_device_id(saved.device_id) && saved.certificate && saved.private_key && common_name_of(saved.certificate) === saved.device_id) {
    return {
      device_id: saved.device_id,
      name: clean_device_name(saved.name ?? defaults.name ?? hostname()),
      type: device_types.includes(saved.type as DeviceType) ? (saved.type as DeviceType) : (defaults.type ?? "desktop"),
      certificate: saved.certificate,
      private_key: saved.private_key,
    };
  }
  const device_id = new_device_id();
  const identity: DeviceIdentity = { device_id, name: clean_device_name(defaults.name ?? hostname()), type: defaults.type ?? "desktop", ...(await make_certificate(device_id)) };
  save_identity(file, identity);
  return identity;
}
