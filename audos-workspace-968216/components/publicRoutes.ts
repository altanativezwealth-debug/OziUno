// Route helpers for the public SEO pages (currently /ai-household-assistant).
//
// The OziUno experience is served from several bases:
//   - https://www.oziuno.com/            — custom domain. The SPA bundle is
//     served on EVERY path, so real subpath routes work; this is the form
//     Google indexes.
//   - https://audos.com/site/<configId>  — platform preview. Subpaths under
//     the base ALSO serve the bundle (verified live), so
//     /site/<id>/ai-household-assistant renders the page too.
//   - https://audos.com/space/<spaceId>  — platform host. Subpaths 404 here.
// Because not every base serves subpaths, links INTO a public page use the
// real path only from the custom-domain root and fall back to a
// ?page=<slug> query param everywhere else — the param form works on every
// base because the pathname is unchanged.

export const AI_ASSISTANT_PATH = '/ai-household-assistant';
export const AI_ASSISTANT_PAGE_PARAM = 'ai-household-assistant';

function normalizedPathname(): string {
  if (typeof window === 'undefined') return '/';
  const raw = window.location.pathname || '/';
  return raw.length > 1 && raw.endsWith('/') ? raw.slice(0, -1) : raw || '/';
}

// True only on the canonical custom-domain path — the indexable form.
// Preview subpaths and the query-param form stay noindex.
export function isAiAssistantCanonicalPath(): boolean {
  return normalizedPathname() === AI_ASSISTANT_PATH;
}

// True whenever the AI-household-assistant page should render: the canonical
// path, a preview subpath (/site/<id>/ai-household-assistant), or the
// ?page= query-param form used on bases that don't serve subpaths.
export function isAiAssistantRoute(): boolean {
  if (typeof window === 'undefined') return false;
  const path = normalizedPathname();
  if (path === AI_ASSISTANT_PATH || path.endsWith(AI_ASSISTANT_PATH)) return true;
  try {
    return new URLSearchParams(window.location.search).get('page') === AI_ASSISTANT_PAGE_PARAM;
  } catch {
    return false;
  }
}

// Href for links INTO the page, valid on whatever base is serving the bundle.
export function aiAssistantHref(): string {
  if (typeof window === 'undefined') return AI_ASSISTANT_PATH;
  if (normalizedPathname() === '/') return AI_ASSISTANT_PATH;
  const params = new URLSearchParams(window.location.search);
  params.set('page', AI_ASSISTANT_PAGE_PARAM);
  return `${window.location.pathname}?${params.toString()}`;
}

// Href for links back to the homepage (optionally to a section anchor),
// valid on whatever base is serving the bundle.
export function homepageHref(anchor?: string): string {
  const hash = anchor ? `#${anchor}` : '';
  if (typeof window === 'undefined') return `/${hash}`;
  const path = normalizedPathname();
  if (path === '/' || path === AI_ASSISTANT_PATH) return `/${hash}`;
  // Preview / platform base: stay on the same base — strip a trailing
  // /ai-household-assistant subpath and the page param.
  let basePath = window.location.pathname;
  if (basePath.endsWith('/')) basePath = basePath.slice(0, -1);
  if (basePath.endsWith(AI_ASSISTANT_PATH)) {
    basePath = basePath.slice(0, -AI_ASSISTANT_PATH.length) || '/';
  }
  const params = new URLSearchParams(window.location.search);
  params.delete('page');
  const search = params.toString();
  return `${basePath || '/'}${search ? `?${search}` : ''}${hash}`;
}
