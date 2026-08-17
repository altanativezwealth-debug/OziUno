import { useState } from 'react';
import { Globe, Lock } from 'lucide-react';
import { tw } from '../../lib/colors';
import CatalogTab from './CatalogTab';
import MyItemsTab from './MyItemsTab';

/* ============================================================================
 * CANONICAL WORKSPACEDB APP — copy this folder's pattern for new apps.
 *
 * This single app demonstrates BOTH persistence modes the platform supports,
 * all through WorkspaceDB (PostgreSQL). There is NO localStorage / sessionStorage
 * anywhere — WorkspaceDB is the only source of truth.
 *
 *   • Shared catalog  (CatalogTab → useCatalog)   — { shared: true }: one set of
 *     rows every visitor reads and writes. For reference/seed/community data.
 *   • Private list    (MyItemsTab → useSavedItems) — default scoping: each visitor
 *     only sees their own rows. For anything personal to the visitor.
 *
 * Structure (keep apps modular — small files, one responsibility each):
 *   App.tsx          → this shell + tab switch
 *   types.ts         → shared types + WorkspaceDB window declarations
 *   useCollection.ts → read hooks + write helpers for both modes
 *   CatalogTab.tsx   → shared-mode UI
 *   MyItemsTab.tsx   → private-mode UI
 *
 * Tables (created on first write). To pre-create them with explicit columns,
 * ask Otto to run db_create_table:
 *   catalog_items: name (text), description (text)
 *   saved_items:   title (text), note (text), done (boolean, default false)
 * id, session_id, created_at, updated_at are added automatically.
 * ==========================================================================*/

type Tab = 'catalog' | 'mine';

export default function Collection() {
  const [tab, setTab] = useState<Tab>('catalog');

  return (
    <div className="flex flex-col h-full bg-transparent">
      <div className="flex items-center justify-between p-4 border-b border-[var(--space-border-default)] bg-[var(--space-surface-card)]">
        <div>
          <h2 className="font-semibold text-lg text-[var(--space-text-primary)]">Collection</h2>
          <p className="text-sm text-[var(--space-text-secondary)]">
            Shared + private data, all in WorkspaceDB
          </p>
        </div>
      </div>

      <div className="flex border-b border-[var(--space-border-default)] bg-[var(--space-surface-card)]">
        <button
          onClick={() => setTab('catalog')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
            tab === 'catalog'
              ? 'border-[var(--space-brand-primary)] text-[var(--space-text-primary)]'
              : 'border-transparent text-[var(--space-text-muted)] hover:text-[var(--space-text-secondary)]'
          }`}
        >
          <Globe className="w-4 h-4" /> Catalog
        </button>
        <button
          onClick={() => setTab('mine')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
            tab === 'mine'
              ? 'border-[var(--space-brand-primary)] text-[var(--space-text-primary)]'
              : 'border-transparent text-[var(--space-text-muted)] hover:text-[var(--space-text-secondary)]'
          }`}
        >
          <Lock className="w-4 h-4" /> My List
        </button>
      </div>

      <div className="flex-1 min-h-0">
        {tab === 'catalog' ? <CatalogTab /> : <MyItemsTab />}
      </div>
    </div>
  );
}
