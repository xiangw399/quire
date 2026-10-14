/**
 * In-process host adapter for DOM verification.
 *
 * The dev server exposes the host API over HTTP; the simulated document calls the
 * same API directly, so the verification exercises the identical read paths
 * without a transport.
 *
 * @param options - the host API to adapt.
 */
export function createShellHost({ api }) {
  return {
    /** One page of lines. */
    page: (request) => api.page({ path: request.path, offset: request.offset }),
    /** Complete bytes, or a window. */
    bytes: (request) => api.bytes({ path: request.path, baseFile: request.baseFile, window: request.window ?? request.range }),
    /** File metadata. */
    stat: (request) => api.stat({ path: request.path }),
    /** One directory level. */
    list: (request) => api.list({ path: request?.path ?? '.' }),
    /** A URL for browser-side consumers; verification never loads one. */
    urlFor: () => 'about:blank',
  };
}
