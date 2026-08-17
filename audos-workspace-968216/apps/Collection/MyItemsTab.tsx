import { useState } from 'react';
import { Plus, Trash2, Check, Lock } from 'lucide-react';
import { tw } from '../../lib/colors';
import { useSavedItems } from './useCollection';

/* PRIVATE mode example — per-visitor rows, scoped to the session automatically. */
export default function MyItemsTab() {
  const { items, loading, error, addSavedItem, toggleSavedItem, removeSavedItem } =
    useSavedItems();
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const handleAdd = async () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await addSavedItem(trimmed, note.trim());
      setTitle('');
      setNote('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-[var(--space-border-default)] bg-[var(--space-surface-panel)]">
        <div className="flex items-center gap-2 mb-3 text-sm text-[var(--space-text-secondary)]">
          <Lock className="w-4 h-4" />
          <span>Private list — only you can see these items.</span>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            placeholder="What do you want to save?"
            className={`${tw.input.default} sm:flex-1`}
          />
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            placeholder="Note (optional)"
            className={`${tw.input.default} sm:flex-1`}
          />
          <button
            onClick={handleAdd}
            disabled={busy || !title.trim()}
            className={`px-3 py-2 ${tw.button.primary} text-sm rounded-md flex items-center justify-center gap-1 disabled:opacity-50`}
          >
            <Plus className="w-4 h-4" /> Save
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="text-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--space-brand-primary)] mx-auto" />
            <p className="text-[var(--space-text-muted)] text-sm mt-2">Loading your list…</p>
          </div>
        ) : error ? (
          <div className="text-center py-12 text-[var(--space-semantic-danger)] text-sm">
            Error: {error.message}
          </div>
        ) : !items || items.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-[var(--space-text-muted)] text-sm">
              Nothing saved yet. Add your first private item above.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((item) => (
              <div key={item.id} className={`p-3 ${tw.card.flat} flex items-start justify-between gap-3`}>
                <button
                  onClick={() => toggleSavedItem(item)}
                  className={`flex items-start gap-3 flex-1 text-left min-w-0 ${item.done ? 'opacity-60' : ''}`}
                >
                  <span
                    className={`mt-0.5 w-5 h-5 rounded border flex items-center justify-center flex-shrink-0 ${
                      item.done
                        ? 'bg-[var(--space-semantic-success)] border-[var(--space-semantic-success)] text-white'
                        : 'border-[var(--space-border-strong)]'
                    }`}
                  >
                    {item.done && <Check className="w-3 h-3" />}
                  </span>
                  <span className="min-w-0">
                    <span className={`block text-[var(--space-text-primary)] ${item.done ? 'line-through' : ''}`}>
                      {item.title}
                    </span>
                    {item.note && (
                      <span className="block text-sm text-[var(--space-text-secondary)] break-words">{item.note}</span>
                    )}
                  </span>
                </button>
                <button
                  onClick={() => removeSavedItem(item.id)}
                  className="p-1 text-[var(--space-text-muted)] hover:text-[var(--space-semantic-danger)] flex-shrink-0"
                  title="Remove"
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
