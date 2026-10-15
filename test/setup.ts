import chrome from "sinon-chrome";
import { beforeEach, afterEach } from "vitest";

// Expose a mocked chrome.* API globally for all tests.
// sinon-chrome provides stubbed implementations of the extension APIs
// (chrome.cookies, chrome.runtime, chrome.action, ...).
(globalThis as unknown as { chrome: typeof chrome }).chrome = chrome;

beforeEach(() => {
  chrome.flush();
});

afterEach(() => {
  chrome.reset();
});
