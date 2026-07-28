/**
 * F2 — Inferred Traits tab.
 *
 * Lists every user-feature aspect the agent has derived from the user's
 * recent messages, lets the user approve (opt into prompt injection),
 * reject (soft-delete), or hard-delete each one. Aspects flagged as
 * `consentRequired` (derived from any batch that mentioned
 * buy/sell/leverage/margin/etc.) sit in `pending` state until the user
 * approves them.
 *
 * Backed by `/user/inferred-traits` endpoints in client-direct/api.ts.
 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

interface AspectRow {
  memoryId: string;
  aspect: {
    name: string;
    content: string;
    version?: number;
    generatedAt?: number;
    consentRequired?: boolean;
    userConsent?: 'approved' | 'rejected' | 'pending';
  };
}

interface InferredTraitsTabProps {
  isDarkMode: boolean;
}

export function InferredTraitsTab({ isDarkMode }: InferredTraitsTabProps) {
  const [rows, setRows] = useState<AspectRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const resp = await fetch('/user/inferred-traits', { credentials: 'include' });
      const body = (await resp.json()) as { success: boolean; traits?: AspectRow[]; message?: string };
      if (!body.success) {
        toast.error(body.message ?? 'Failed to load inferred traits');
        setRows([]);
      } else {
        setRows(body.traits ?? []);
      }
    } catch (err) {
      toast.error(`Failed to load inferred traits: ${err instanceof Error ? err.message : String(err)}`);
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const setConsent = async (memoryId: string, consent: 'approved' | 'rejected' | 'pending') => {
    setPendingId(memoryId);
    try {
      const resp = await fetch(`/user/inferred-traits/${encodeURIComponent(memoryId)}/consent`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ consent }),
      });
      const body = (await resp.json()) as { success: boolean; message?: string };
      if (!body.success) {
        toast.error(body.message ?? 'Failed to update consent');
      } else {
        toast.success(`Trait ${consent}`);
        await load();
      }
    } catch (err) {
      toast.error(`Failed to update consent: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPendingId(null);
    }
  };

  const deleteOne = async (memoryId: string) => {
    setPendingId(memoryId);
    try {
      const resp = await fetch(`/user/inferred-traits/${encodeURIComponent(memoryId)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const body = (await resp.json()) as { success: boolean; message?: string };
      if (!body.success) {
        toast.error(body.message ?? 'Failed to delete trait');
      } else {
        toast.success('Trait deleted');
        await load();
      }
    } catch (err) {
      toast.error(`Failed to delete trait: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPendingId(null);
    }
  };

  const deleteAll = async () => {
    if (!confirm('Delete all inferred traits? This cannot be undone.')) return;
    try {
      const resp = await fetch('/user/inferred-traits', { method: 'DELETE', credentials: 'include' });
      const body = (await resp.json()) as { success: boolean; removed?: number };
      if (body.success) {
        toast.success(`Deleted ${body.removed ?? 0} traits`);
        await load();
      } else {
        toast.error('Failed to delete all traits');
      }
    } catch (err) {
      toast.error(`Failed to delete all traits: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className={isDarkMode ? 'text-white' : 'text-slate-900'}>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Inferred Traits</h2>
          <p className={isDarkMode ? 'text-white/60 text-sm' : 'text-slate-500 text-sm'}>
            What the agent has inferred about you from recent chats. Traits flagged
            <span className="font-medium"> consent required </span>
            (typically derived from trading conversations) are only injected into prompts after you approve them.
          </p>
        </div>
        <button
          type="button"
          onClick={deleteAll}
          disabled={rows.length === 0 || loading}
          className={
            isDarkMode
              ? 'rounded-md border border-red-500/30 px-3 py-1.5 text-sm text-red-300 hover:bg-red-500/10 disabled:opacity-40'
              : 'rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-40'
          }
        >
          Delete all
        </button>
      </div>

      {loading && <div className="text-sm opacity-60">Loading…</div>}
      {!loading && rows.length === 0 && (
        <div className={isDarkMode ? 'text-white/60 text-sm' : 'text-slate-500 text-sm'}>
          No inferred traits yet.
        </div>
      )}
      {!loading && rows.length > 0 && (
        <ul className="space-y-3">
          {rows.map(({ memoryId, aspect }) => {
            const consent = aspect.userConsent ?? (aspect.consentRequired ? 'pending' : 'approved');
            const consentLabel =
              consent === 'approved'
                ? 'Injected'
                : consent === 'rejected'
                  ? 'Excluded'
                  : 'Pending — needs approval';
            const consentClass =
              consent === 'approved'
                ? isDarkMode
                  ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                  : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                : consent === 'rejected'
                  ? isDarkMode
                    ? 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30'
                    : 'bg-zinc-100 text-zinc-700 border-zinc-200'
                  : isDarkMode
                    ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                    : 'bg-amber-50 text-amber-800 border-amber-200';
            const disabled = pendingId === memoryId;
            return (
              <li
                key={memoryId}
                className={
                  isDarkMode
                    ? 'rounded-lg border border-white/10 bg-white/5 p-3'
                    : 'rounded-lg border border-slate-200 bg-white p-3'
                }
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <div className="font-medium truncate">{aspect.name}</div>
                      <span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${consentClass}`}>
                        {consentLabel}
                      </span>
                    </div>
                    <div className={isDarkMode ? 'text-white/80 text-sm mt-1' : 'text-slate-700 text-sm mt-1'}>
                      {aspect.content}
                    </div>
                    {typeof aspect.version === 'number' && (
                      <div className={isDarkMode ? 'text-white/40 text-xs mt-1' : 'text-slate-400 text-xs mt-1'}>
                        v{aspect.version}
                        {aspect.generatedAt
                          ? ` · ${new Date(aspect.generatedAt).toLocaleString()}`
                          : ''}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {consent !== 'approved' && (
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => setConsent(memoryId, 'approved')}
                        className={
                          isDarkMode
                            ? 'rounded border border-emerald-500/30 px-2.5 py-1 text-xs text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40'
                            : 'rounded border border-emerald-300 px-2.5 py-1 text-xs text-emerald-700 hover:bg-emerald-50 disabled:opacity-40'
                        }
                      >
                        Approve
                      </button>
                    )}
                    {consent !== 'rejected' && (
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => setConsent(memoryId, 'rejected')}
                        className={
                          isDarkMode
                            ? 'rounded border border-zinc-500/30 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-500/10 disabled:opacity-40'
                            : 'rounded border border-zinc-300 px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-100 disabled:opacity-40'
                        }
                      >
                        Reject
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => deleteOne(memoryId)}
                      className={
                        isDarkMode
                          ? 'rounded border border-red-500/30 px-2.5 py-1 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-40'
                          : 'rounded border border-red-300 px-2.5 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-40'
                      }
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
