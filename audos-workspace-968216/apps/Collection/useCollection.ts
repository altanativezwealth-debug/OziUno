import type { CatalogItem, SavedItem } from './types';

/* CANONICAL TEMPLATE - the two WorkspaceDB modes, side by side.
 *
 * SHARED mode  → useCatalog(): pass { shared: true } so all visitors read and
 *                write ONE common catalog. Use for reference/seed data.
 * PRIVATE mode → useSavedItems(): default scoping means each visitor only sees
 *                their own rows. Use for anything personal to the visitor.
 *
 * Reads come from window.useWorkspaceDB(...). Writes go through
 * window.__workspaceDb.from(table).insert / update / delete. The id,
 * session_id, created_at and updated_at columns are filled in automatically.
 */

// --- SHARED catalog (everyone sees the same rows) --------------------------
export function useCatalog() {
  const { data, loading, error, refresh } = window.useWorkspaceDB<CatalogItem>(
    'catalog_items',
    {
      shared: true,
      orderBy: { column: 'created_at', direction: 'desc' },
      limit: 100,
    },
  );

  const addCatalogItem = async (name: string, description: string) => {
    // from(table, { shared: true }) on the write puts the row in the common
    // catalog (the same { shared } scope must be passed for reads and writes).
    await window.__workspaceDb
      .from('catalog_items', { shared: true })
      .insert({ name, description: description || null });
    refresh();
  };

  const removeCatalogItem = async (id: number) => {
    await window.__workspaceDb.from('catalog_items', { shared: true }).delete(id);
    refresh();
  };

  return { items: data, loading, error, refresh, addCatalogItem, removeCatalogItem };
}

// --- PRIVATE saved items (per-visitor, session-scoped) ----------------------
export function useSavedItems() {
  const { data, loading, error, refresh } = window.useWorkspaceDB<SavedItem>(
    'saved_items',
    {
      orderBy: { column: 'created_at', direction: 'desc' },
      limit: 100,
    },
  );

  const addSavedItem = async (title: string, note: string) => {
    // No { shared } → row is automatically scoped to this visitor's session.
    await window.__workspaceDb
      .from('saved_items')
      .insert({ title, note: note || null, done: false });
    refresh();
  };

  const toggleSavedItem = async (item: SavedItem) => {
    await window.__workspaceDb
      .from('saved_items')
      .update(item.id, { done: !item.done });
    refresh();
  };

  const removeSavedItem = async (id: number) => {
    await window.__workspaceDb.from('saved_items').delete(id);
    refresh();
  };

  return {
    items: data,
    loading,
    error,
    refresh,
    addSavedItem,
    toggleSavedItem,
    removeSavedItem,
  };
}
