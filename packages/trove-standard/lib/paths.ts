// The well-known paths the standard requires a trove to serve (§2). The
// index page is listed in the manifest as "/", not "/index.html" — the host
// canonicalizes /index.html with a 307 to /, so "/" is the path that returns
// 200 directly.
export const INDEX_PATH = "/"
export const AGENTS_MD_PATH = "/AGENTS.md"
export const MANIFEST_PATH = "/trove.json"
