import { describe, it, expect } from "vitest";
import manifest from "../../manifest.json";

// Feature: ipaas-helper-extension — Manifest smoke tests
// Validates: Requirements 1.4, 1.5
//
// These configuration-level tests assert the MV3 manifest requests exactly the
// three allowed hosts and nothing more (Req 1.5), exposes the Session_Panel as
// a toolbar action rather than injecting it into pages (Req 1.4), and holds the
// `cookies` permission needed to read the session cookie.

const ALLOWED_HOSTS = [
  "https://ipaas.totvs.app/",
  "https://api-ipaas.totvs.app/",
  "https://api-fluig.totvs.app/",
] as const;

describe("manifest smoke tests", () => {
  it("declares manifest version 3", () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it("requests host access to exactly the three allowed hosts and nothing else (Req 1.5)", () => {
    const hosts = manifest.host_permissions;

    // Same length → no extra hosts beyond the allowed set.
    expect(hosts).toHaveLength(ALLOWED_HOSTS.length);

    // Every allowed host is present.
    for (const host of ALLOWED_HOSTS) {
      expect(hosts).toContain(host);
    }

    // No host outside the allowed set is present.
    for (const host of hosts) {
      expect(ALLOWED_HOSTS).toContain(host as (typeof ALLOWED_HOSTS)[number]);
    }

    // Exact set equality, order-independent.
    expect([...hosts].sort()).toEqual([...ALLOWED_HOSTS].sort());
  });

  it("requests the storage permission and NOT the cookies permission (Req 1.6)", () => {
    expect(manifest.permissions).toContain("storage");
    expect(manifest.permissions).not.toContain("cookies");
  });

  it("exposes the session panel via the toolbar action popup (Req 1.4)", () => {
    expect(manifest.action).toBeDefined();
    expect(manifest.action.default_popup).toBe("popup.html");
    expect(manifest.action.default_popup).toBeTruthy();
  });

  it("does not inject the session panel through any content script (Req 1.4)", () => {
    const scripts = manifest.content_scripts ?? [];

    for (const script of scripts) {
      const injected = script.js ?? [];
      // The popup/panel entry must never be injected into pages.
      expect(injected).not.toContain("popup.html");
      expect(injected).not.toContain("src/popup.ts");
      expect(injected).not.toContain("popup.ts");
      expect(injected).not.toContain("popup.js");
    }
  });

  it("scopes the content script to all iPaaS pages at document_idle (Req 2.2, 2.3)", () => {
    const scripts = manifest.content_scripts ?? [];
    expect(scripts).toHaveLength(1);

    // Broadened from /builder/* to /* so the popup can capture the session from
    // any active iPaaS tab; builder helpers stay gated by a runtime path check.
    const [script] = scripts;
    expect(script.matches).toEqual(["https://ipaas.totvs.app/*"]);
    expect(script.run_at).toBe("document_idle");
  });

  it("registers the background service worker as an ES module", () => {
    expect(manifest.background.type).toBe("module");
    expect(manifest.background.service_worker).toBeTruthy();
  });
});
