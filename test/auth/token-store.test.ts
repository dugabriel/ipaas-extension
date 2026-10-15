import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getStoredToken,
  storeToken,
  clearStoredToken,
} from "../../src/auth/auth-service";

// Feature: ipaas-helper-extension — Captured_Token storage (Req 2.4)
//
// The session token is captured by the content script from document.cookie and
// persisted by the worker in chrome.storage.session. These tests exercise the
// AuthService accessors against an in-memory stub of chrome.storage.session.

const KEY = "ipaas_jwt_token";

function installStorageStub(): Record<string, unknown> {
  const mem: Record<string, unknown> = {};
  const session = {
    get: vi.fn(async (k: string) => (k in mem ? { [k]: mem[k] } : {})),
    set: vi.fn(async (obj: Record<string, unknown>) => {
      Object.assign(mem, obj);
    }),
    remove: vi.fn(async (k: string) => {
      delete mem[k];
    }),
  };
  (globalThis as unknown as { chrome: { storage: { session: typeof session } } }).chrome = {
    storage: { session },
  } as never;
  return mem;
}

describe("Captured_Token storage (Req 2.4)", () => {
  let mem: Record<string, unknown>;
  beforeEach(() => {
    mem = installStorageStub();
  });

  it("returns null when no token has been captured", async () => {
    expect(await getStoredToken()).toBeNull();
  });

  it("stores and reads back a captured token", async () => {
    await storeToken("header.payload.signature");
    expect(mem[KEY]).toBe("header.payload.signature");
    expect(await getStoredToken()).toBe("header.payload.signature");
  });

  it("treats an empty-string token as no session (removes it)", async () => {
    await storeToken("");
    expect(await getStoredToken()).toBeNull();
    expect(KEY in mem).toBe(false);
  });

  it("storeToken(null) clears the stored token", async () => {
    await storeToken("abc");
    await storeToken(null);
    expect(await getStoredToken()).toBeNull();
  });

  it("clearStoredToken removes the token", async () => {
    await storeToken("abc");
    await clearStoredToken();
    expect(await getStoredToken()).toBeNull();
  });
});
