declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
  }
}

/** Vite's glob import, used to load every migration in test/helpers.ts. */
interface ImportMeta {
  glob(pattern: string, options?: Record<string, unknown>): Record<string, unknown>;
}

declare module '*.sql?raw' {
  const content: string;
  export default content;
}

declare module '*.html?raw' {
  const content: string;
  export default content;
}
