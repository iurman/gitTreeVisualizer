/**
 * Minimal request and response shapes. Vercel's Node runtime passes Node's own
 * http objects with a few conveniences added; typing just what we use keeps the
 * functions free of a build-time dependency.
 */
export type ApiRequest = {
  url?: string;
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | string[] | undefined>;
};

export type ApiResponse = {
  status(code: number): ApiResponse;
  setHeader(name: string, value: string | number | readonly string[]): void;
  json(body: unknown): void;
  send(body: string | Buffer): void;
  end(body?: string): void;
};

export const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;
