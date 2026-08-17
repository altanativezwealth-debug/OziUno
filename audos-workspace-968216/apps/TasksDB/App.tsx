import { useMemo, useState } from 'react';
import { Plus, Trash2, Check, ListTodo } from 'lucide-react';

/* CANONICAL TEMPLATE - Copy this pattern for new apps that need persistence */

/**
 * Tasks (WorkspaceDB) — the canonical persistence pattern for new apps.
 *
 * Why this app exists:
 * - Demonstrates `useWorkspaceDB` for reads and `window.__workspaceDb` for writes.
 * - These exact identifiers trigger the platform to auto-inject the WorkspaceDB SDK
 *   at compile time. No imports, no config — just reference them.
 * - Each visitor gets their own rows automatically (session scoping). Use
 *   `{ shared: true }` only for catalog/reference data that everyone should see.
 *
 * UI conventions worth copying:
 * - Style with the shared `--space-*` CSS variables so the app follows the
 *   workspace theme (light/dark, brand color) with zero extra work.
 * - Optimistic disable (`busy`) on writes, explicit loading / error / empty
 *   states on reads. Never leave the user staring at a blank panel.
 *
 * The `tasks` table is created on first write. To pre-create it (recommended),
 * ask Otto to run db_create_table for `tasks` with columns: title (text),
 * done (boolean, default false). The `id`, `session_id`, `created_at`, and
 * `updated_at` columns are added automatically.
 */

interface Task {
  id: number;
  title: string;
  done: boolean;
  created_at?: string;
}

declare global {
  interface Window {
    useWorkspaceDB: <T = any>(
      table: string,
      options?: { shared?: boolean; limit?: number; offset?: number; orderBy?: { column: string; direction: 'asc' | 'desc' }; filters?: Array<{ column: string; operator: string; value: any }> }
    ) => { data: T[]; loading: boolean; error: Error | null; total: number; refresh: () => void };
    __workspaceDb: any;
  }
}

export default function TasksDB() {
  // READ: useWorkspaceDB returns { data, loading, error, refresh }.
  // Default scoping is per-visitor (session-scoped). Use { shared: true } for
  // catalog data that all visitors should see.
  const { data: tasks, loading, error, refresh } = window.useWorkspaceDB<Task>('tasks', {
    orderBy: { column: 'created_at', direction: 'desc' },
    limit: 100,
  });

  const [newTitle, setNewTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const remaining = useMemo(
    () => (tasks || []).filter((t) => !t.done).length,
    [tasks],
  );

  // WRITE: window.__workspaceDb.from(table).insert / update / delete.
  // session_id is filled in automatically.
  const handleAdd = async () => {
    const title = newTitle.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      await window.__workspaceDb.from('tasks').insert({ title, done: false });
      setNewTitle('');
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const handleToggle = async (task: Task) => {
    await window.__workspaceDb.from('tasks').update(task.id, { done: !task.done });
    refresh();
  };

  const handleDelete = async (id: number) => {
    await window.__workspaceDb.from('tasks').delete(id);
    refresh();
  };

  return (
    <div className="flex flex-col h-full bg-transparent">
      {/* Composer — the shell's panel header already shows the app name, so
          the app itself starts straight with the action row (no duplicate title). */}
      <div className="px-5 pt-2 pb-3">
        <div className="flex gap-2">
          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            placeholder="What needs doing?"
            className="flex-1 min-w-0 px-3.5 py-2 text-sm rounded-lg border border-[var(--space-border-default)] bg-[var(--space-surface-card)] text-[var(--space-text-primary)] placeholder:text-[var(--space-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--space-brand-primary-500)] focus:border-transparent"
            data-testid="input-new-task"
          />
          <button
            onClick={handleAdd}
            disabled={busy || !newTitle.trim()}
            className="px-3.5 py-2 rounded-lg bg-[var(--space-brand-primary-500)] text-white text-sm font-medium flex items-center gap-1.5 hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
            data-testid="button-add-task"
          >
            <Plus className="w-4 h-4" /> Add
          </button>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-14 gap-3">
            <div className="animate-spin rounded-full h-7 w-7 border-2 border-[var(--space-border-default)] border-t-[var(--space-brand-primary-500)]" />
            <p className="text-sm text-[var(--space-text-muted)]">Loading tasks…</p>
          </div>
        ) : error ? (
          <div className="text-center py-14">
            <p className="text-sm text-red-600">Couldn't load tasks: {error.message}</p>
            <button
              onClick={refresh}
              className="mt-3 px-3 py-1.5 text-sm rounded-lg border border-[var(--space-border-default)] text-[var(--space-text-primary)] hover:bg-[var(--space-surface-muted)]"
            >
              Try again
            </button>
          </div>
        ) : !tasks || tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-14 gap-2 text-center">
            <div className="w-11 h-11 rounded-2xl bg-[var(--space-surface-muted)] flex items-center justify-center">
              <ListTodo className="w-5 h-5 text-[var(--space-text-muted)]" />
            </div>
            <p className="text-sm font-medium text-[var(--space-text-primary)]">No tasks yet</p>
            <p className="text-xs text-[var(--space-text-muted)]">Add your first task above — it's saved automatically.</p>
          </div>
        ) : (
          <>
            <p className="px-1 pb-2 text-xs text-[var(--space-text-muted)]">
              {remaining} open · saved to your workspace
            </p>
            <ul className="space-y-2">
            {tasks.map((task) => (
              <li
                key={task.id}
                className="group flex items-center gap-3 px-3.5 py-2.5 rounded-xl border border-[var(--space-border-default)] bg-[var(--space-surface-card)] transition-colors hover:border-[var(--space-brand-primary-500)]/40"
                data-testid={`row-task-${task.id}`}
              >
                <button
                  onClick={() => handleToggle(task)}
                  className="flex items-center gap-3 flex-1 min-w-0 text-left"
                  data-testid={`button-toggle-task-${task.id}`}
                >
                  <span
                    className={`w-5 h-5 shrink-0 rounded-md border flex items-center justify-center transition-colors ${
                      task.done
                        ? 'bg-[var(--space-brand-primary-500)] border-[var(--space-brand-primary-500)] text-white'
                        : 'border-[var(--space-border-default)] group-hover:border-[var(--space-brand-primary-500)]'
                    }`}
                  >
                    {task.done && <Check className="w-3 h-3" />}
                  </span>
                  <span
                    className={`truncate text-sm ${
                      task.done
                        ? 'text-[var(--space-text-muted)] line-through'
                        : 'text-[var(--space-text-primary)]'
                    }`}
                  >
                    {task.title}
                  </span>
                </button>
                <button
                  onClick={() => handleDelete(task.id)}
                  className="p-1.5 rounded-md text-[var(--space-text-muted)] opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-red-600 hover:bg-red-500/10 transition-all"
                  aria-label="Delete task"
                  data-testid={`button-delete-task-${task.id}`}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ul>
          </>
        )}
      </div>
    </div>
  );
}
