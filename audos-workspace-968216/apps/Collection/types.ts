/* CANONICAL TEMPLATE - shared types + WorkspaceDB window declarations.
 *
 * Every app that talks to WorkspaceDB references the same two globals:
 *   - window.useWorkspaceDB(...)   → reads (a React hook)
 *   - window.__workspaceDb         → writes (insert / update / delete)
 *
 * Referencing these exact identifiers anywhere in the app's source is what
 * tells the platform to auto-inject the WorkspaceDB SDK at compile time.
 * No imports, no config — just use them.
 */

export interface WorkspaceDbReadOptions {
  // Scope: omit (or false) for per-visitor (session-scoped) rows; set true to
  // read a single shared catalog every visitor sees.
  shared?: boolean;
  limit?: number;
  offset?: number;
  orderBy?: { column: string; direction: 'asc' | 'desc' };
  filters?: Array<{ column: string; operator: string; value: any }>;
}

export interface WorkspaceDbReadResult<T> {
  data: T[];
  loading: boolean;
  error: Error | null;
  total: number;
  refresh: () => void;
}

declare global {
  interface Window {
    useWorkspaceDB: <T = any>(
      table: string,
      options?: WorkspaceDbReadOptions,
    ) => WorkspaceDbReadResult<T>;
    __workspaceDb: any;
  }
}

// Shared catalog row — visible to EVERY visitor (written with { shared: true }).
export interface CatalogItem {
  id: number;
  name: string;
  description: string | null;
  created_at?: string;
}

// Private row — each visitor only ever sees their own (session-scoped).
export interface SavedItem {
  id: number;
  title: string;
  note: string | null;
  done: boolean;
  created_at?: string;
}
