import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, Plus, AlertCircle, Check, Loader2 } from 'lucide-react';
import {
  searchExpenseSuppliers,
  matchExpenseSupplier,
  createExpenseSupplier,
  type ExpenseSupplier,
} from '../../api';

interface Props {
  value: { id: number | null; name: string };
  onChange: (next: { id: number | null; name: string }) => void;
  placeholder?: string;
  autoFocus?: boolean;
}

const VendorCombobox: React.FC<Props> = ({ value, onChange, placeholder, autoFocus }) => {
  const { t } = useTranslation('admin');
  const [query, setQuery] = useState(value.name || '');
  const [results, setResults] = useState<ExpenseSupplier[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [creating, setCreating] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState<ExpenseSupplier | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchSeq = useRef(0);
  const matchSeq = useRef(0);

  // Sync external value changes (e.g. set by receipt scan)
  useEffect(() => {
    if (value.name !== query) setQuery(value.name || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.id, value.name]);

  // Debounced search
  useEffect(() => {
    if (!open) return;
    const seq = ++searchSeq.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const rows = await searchExpenseSuppliers(query.trim(), 10);
        if (seq === searchSeq.current) {
          setResults(rows);
          setActiveIdx(rows.length > 0 ? 0 : -1);
        }
      } catch {
        if (seq === searchSeq.current) setResults([]);
      } finally {
        if (seq === searchSeq.current) setLoading(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [query, open]);

  // Fuzzy "did you mean?" — fires when typing a non-matching name
  useEffect(() => {
    const name = query.trim();
    if (!name || value.id) {
      setDuplicateWarning(null);
      return;
    }
    // Skip if the typed name exactly matches a result we already see
    const exactInResults = results.some(r => r.name.trim().toLowerCase() === name.toLowerCase());
    if (exactInResults) {
      setDuplicateWarning(null);
      return;
    }
    const seq = ++matchSeq.current;
    const t = setTimeout(async () => {
      try {
        const { match } = await matchExpenseSupplier(name, 0.5);
        if (seq === matchSeq.current) {
          setDuplicateWarning(match && match.score < 1 ? match : null);
        }
      } catch {
        if (seq === matchSeq.current) setDuplicateWarning(null);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [query, value.id, results]);

  // Outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const trimmedQuery = query.trim();
  const showCreateOption = useMemo(() => {
    if (!trimmedQuery) return false;
    return !results.some(r => r.name.trim().toLowerCase() === trimmedQuery.toLowerCase());
  }, [trimmedQuery, results]);

  const handleSelect = (supplier: ExpenseSupplier) => {
    onChange({ id: supplier.id, name: supplier.name });
    setQuery(supplier.name);
    setOpen(false);
    setDuplicateWarning(null);
  };

  const handleCreate = async () => {
    if (!trimmedQuery || creating) return;
    setCreating(true);
    try {
      const created = await createExpenseSupplier({ name: trimmedQuery });
      handleSelect(created);
    } catch (err) {
      console.error('[VendorCombobox] Create failed', err);
    } finally {
      setCreating(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        setOpen(true);
        e.preventDefault();
      }
      return;
    }
    const total = results.length + (showCreateOption ? 1 : 0);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx(i => (i + 1) % Math.max(total, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx(i => (i - 1 + Math.max(total, 1)) % Math.max(total, 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIdx >= 0 && activeIdx < results.length) {
        handleSelect(results[activeIdx]);
      } else if (showCreateOption) {
        handleCreate();
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div ref={wrapperRef} className="relative">
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500 pointer-events-none" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          autoFocus={autoFocus}
          onChange={e => {
            const next = e.target.value;
            setQuery(next);
            setOpen(true);
            // Typing breaks the bound supplier link unless the new value still matches its name
            if (value.id && next.trim().toLowerCase() !== value.name.trim().toLowerCase()) {
              onChange({ id: null, name: next });
            } else if (!value.id) {
              onChange({ id: null, name: next });
            }
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder || t('expenses.vendorSearchPlaceholder')}
          className="w-full bg-neutral-800 border border-neutral-700 rounded-lg pl-9 pr-9 py-2 text-white placeholder-neutral-500 focus:border-brand-500 focus:outline-none"
          aria-autocomplete="list"
          aria-expanded={open}
        />
        {value.id && (
          <Check size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-cockpit-in-text" aria-label={t('expenses.vendorLinked')} />
        )}
        {loading && !value.id && (
          <Loader2 size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500 animate-spin" />
        )}
      </div>

      {duplicateWarning && !open && (
        <button
          type="button"
          onClick={() => handleSelect(duplicateWarning)}
          className="mt-1 w-full flex items-center gap-2 px-3 py-2 text-left bg-cockpit-yellow/40 border border-cockpit-yellow/60 rounded-lg text-cockpit-attention-text text-xs hover:bg-cockpit-yellow/60 transition-colors"
        >
          <AlertCircle size={14} className="shrink-0" />
          <span>{t('expenses.didYouMean', { name: duplicateWarning.name })}</span>
        </button>
      )}

      {open && (
        <div className="absolute z-20 mt-1 w-full bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl max-h-72 overflow-y-auto">
          {results.length === 0 && !showCreateOption && !loading && (
            <div className="px-3 py-3 text-sm text-neutral-500">{t('expenses.noSuppliersFound')}</div>
          )}
          {results.map((s, idx) => {
            const isActive = idx === activeIdx;
            return (
              <button
                key={s.id}
                type="button"
                onMouseDown={e => e.preventDefault()}
                onClick={() => handleSelect(s)}
                onMouseEnter={() => setActiveIdx(idx)}
                className={`w-full flex items-center justify-between gap-3 px-3 py-2 text-left transition-colors ${
                  isActive ? 'bg-brand-600/20 text-white' : 'text-neutral-200 hover:bg-neutral-800'
                }`}
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{s.name}</div>
                  {(s.contact_name || s.phone) && (
                    <div className="text-xs text-neutral-500 truncate">
                      {[s.contact_name, s.phone].filter(Boolean).join(' · ')}
                    </div>
                  )}
                </div>
                {value.id === s.id && <Check size={14} className="text-cockpit-in-text shrink-0" />}
              </button>
            );
          })}
          {showCreateOption && (
            <button
              type="button"
              onMouseDown={e => e.preventDefault()}
              onClick={handleCreate}
              onMouseEnter={() => setActiveIdx(results.length)}
              disabled={creating}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left border-t border-neutral-800 transition-colors ${
                activeIdx === results.length ? 'bg-brand-600/20' : 'hover:bg-neutral-800'
              } text-brand-300 disabled:opacity-50`}
            >
              {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              <span className="text-sm">{t('expenses.createSupplierNamed', { name: trimmedQuery })}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default VendorCombobox;
