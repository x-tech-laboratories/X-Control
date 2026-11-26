// Checks on a peer's certificate that the handshake and payloads make, read without Node, so they run on a phone too.

// ── Imports ──────────────────────────────────────────────────────────────────

// The certificate library needs the metadata polyfill loaded before it.
import "reflect-metadata";
import { X509Certificate } from "@peculiar/x509";

// ── Certificates ─────────────────────────────────────────────────────────────

// The common name a certificate carries, which a peer's must match its device id.
export function common_name_of(certificate: string): string | null {
  for (const name of new X509Certificate(certificate).subjectName.toJSON()) {
    const common = name.CN?.[0];
    if (common !== undefined) return common.trim();
  }
  return null;
}

// Whether two certificates are the same one, byte for byte.
export function same_certificate(first: string, second: string): boolean {
  const one = new Uint8Array(new X509Certificate(first).rawData);
  const two = new Uint8Array(new X509Certificate(second).rawData);
  return one.length === two.length && one.every((byte, index) => byte === two[index]);
}
