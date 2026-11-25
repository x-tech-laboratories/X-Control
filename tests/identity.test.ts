import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { common_name_of, load_identity, make_certificate, same_certificate, verification_key } from "../src/server/kdeconnect/identity.ts";

const folders: string[] = [];
afterEach(() => folders.splice(0).forEach((folder) => rmSync(folder, { recursive: true, force: true })));

function temp_file(): string {
  const folder = mkdtempSync(join(tmpdir(), "x-control-identity-"));
  folders.push(folder);
  return join(folder, "identity.json");
}

describe("the device identity", () => {
  test("is made once, kept private, and read back the same", async () => {
    const file = temp_file();
    const first = await load_identity(file, { name: "Laptop", type: "laptop" });
    const again = await load_identity(file);
    expect(again).toEqual(first);
    expect(common_name_of(first.certificate)).toBe(first.device_id);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("is made again when its file is damaged", async () => {
    const file = temp_file();
    writeFileSync(file, "{ broken");
    const identity = await load_identity(file);
    expect(JSON.parse(readFileSync(file, "utf8")).device_id).toBe(identity.device_id);
  });

  test("certificates are told apart", async () => {
    const first = await make_certificate("a".repeat(32));
    const second = await make_certificate("a".repeat(32));
    expect(same_certificate(first.certificate, first.certificate)).toBe(true);
    expect(same_certificate(first.certificate, second.certificate)).toBe(false);
  });

  test("the verification key is the same from both sides and changes with the time", async () => {
    const first = await make_certificate("a".repeat(32));
    const second = await make_certificate("b".repeat(32));
    const key = verification_key(first.certificate, second.certificate, 1_700_000_000);
    expect(key).toMatch(/^[0-9A-F]{8}$/);
    expect(verification_key(second.certificate, first.certificate, 1_700_000_000)).toBe(key);
    expect(verification_key(first.certificate, second.certificate, 1_700_000_001)).not.toBe(key);
  });
});
