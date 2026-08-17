import { useState } from 'react';
import { Plus, Trash2, Globe } from 'lucide-react';
import { tw } from '../../lib/colors';
import { useCatalog } from './useCollection';

/* SHARED mode example — one catalog every visitor reads and writes. */
export default function CatalogTab() {
  const { items, loading, error, addCatalogItem, removeCatalogItem } = useCatalog();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  const handleAdd = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await addCatalogItem(trimmed, description.trim());
      setName('');
      setDescription('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-[var(--space-border-default)] bg-[var(--space-surface-panel)]">
        <div className="flex items-center gap-2 mb-3 text-sm text-[var(--space-text-secondary)]">
          <Globe className="w-4 h-4" />
          <span>Shared catalog — everyone who visits sees these items.</span>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            placeholder="Item name"
            className={`${tw.input.default} sm:flex-1`}
          />
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            placeholder="Description (optional)"
            className={`${tw.input.default} sm:flex-1`}
          />
          <button
            onClick={handleAdd}
            disabled={busy || !name.trim()}
            className={`px-3 py-2 ${tw.button.primary} text-sm rounded-md flex items-center justify-center gap-1 disabled:opacity-50`}
          >
            <Plus className="w-4 h-4" /> Add
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="text-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--space-brand-primary)] mx-auto" />
            <p className="text-[var(--space-text-muted)] text-sm mt-2">Loading catalog…</p>
          </div>
        ) : error ? (
          <div className="text-center py-12 text-[var(--space-semantic-danger)] text-sm">
            Error: {error.message}
          </div>
        ) : !items || items.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-[var(--space-text-muted)] text-sm">
              The catalog is empty. Add the first shared item above.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((item) => (
              <div key={item.id} className={`p-3 ${tw.card.flat} flex items-start justify-between gap-3`}>
                <div className="min-w-0">
                  <p className="font-medium text-[var(--space-text-primary)] truncate">{item.name}</p>
                  {item.description && (
                    <p className="text-sm text-[var(--space-text-secondary)] break-words">{item.description}</p>
                  )}
                </div>
                <button
                  onClick={() => removeCatalogItem(item.id)}
                  className="p-1 text-[var(--space-text-muted)] hover:text-[var(--space-semantic-danger)] flex-shrink-0"
                  title="Remove from shared catalog"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
