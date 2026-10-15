// Minimal ambient declaration for sinon-chrome, which ships without types.
// The mocked chrome.* surface is accessed dynamically in tests, so `any` is
// acceptable here.
declare module "sinon-chrome" {
  const chrome: typeof globalThis.chrome & {
    flush(): void;
    reset(): void;
  };
  export default chrome;
}
