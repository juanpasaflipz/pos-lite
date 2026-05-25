import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Loader2, Search, User, UserCircle2 } from 'lucide-react';
import {
  matchExpensePayee,
  searchExpensePayees,
  type ExpensePayee,
} from '../../api';

interface Props {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}

const PayeeCombobox: React.FC<Props> = ({ value, onChange, placeholder, autoFocus }) => {
  const { t } = useTranslation('admin');
  const [query, setQuery] = useState(value || '');
  const [results, setResults] = useState<ExpensePayee[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [suggestion, setSuggestion] = useState<ExpensePayee | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchSeq = useRef(0);
  const matchSeq = useRef(0);

  // External value sync (e.g. receipt scan auto-fill)
  useEffect(() => {
    if (value !== query) setQuery(value || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Debounced search
  useEffect(() => {
    if (!open) return;
    const seq = ++searchSeq.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const rows = await searchExpensePayees(query.trim(), 10);
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

  // "Did you mean?" — fires when typing a name that isn't in results
  useEffect(() => {
    const name = query.trim();
    if (!name) {
      setSuggestion(null);
      return;
    }
    const exactInResults = results.some(r => r.name.trim().toLowerCase() === name.toLowerCase());
    if (exactInResults) {
      setSuggestion(null);
      return;
    }
    const seq = ++matchSeq.current;
    const t = setTimeout(async () => {
      try {
        const { match } = await matchExpensePayee(name, 0.5);
        if (seq === matchSeq.current) {
          setSuggestion(match && match.score < 1 ? match : null);
        }
      } catch {
        if (seq === matchSeq.current) setSuggestion(null);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [query, results]);

  // Outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const trimmed = query.trim();
  const showTypedOption = useMemo(() => {
    if (!trimmed) return false;
    return !results.some(r => r.name.trim().toLowerCase() === trimmed.toLowerCase());
  }, [trimmed, results]);

  const handleSelect = (payee: ExpensePayee) => {
    setQuery(payee.name);
    onChange(payee.name);
    setOpen(false);
    setSuggestion(null);
  };

  const handleAcceptTyped = () => {
    setOpen(false);
    setSuggestion(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        setOpen(true);
        e.preventDefault();
      }
      return;
    }
    const total = results.length + (showTypedOption ? 1 : 0);
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
      } else if (showTypedOption) {
        handleAcceptTyped();
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
          onChange={(e) => {
            const next = e.target.value;
            setQuery(next);
            onChange(next);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder || t('expenses.payeePlaceholder')}
          className="w-full bg-neutral-800 border border-neutral-700 rounded-lg pl-9 pr-9 py-2 text-white placeholder-neutral-500 focus:border-brand-500 focus:outline-none"
          aria-autocomplete="list"
          aria-expanded={open}
        />
        {loading && (
          <Loader2 size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500 animate-spin" />
        )}
      </div>

      {suggestion && !open && (
        <button
          type="button"
          onClick={() => handleSelect(suggestion)}
          className="mt-1 w-full flex items-center gap-2 px-3 py-2 text-left bg-cockpit-yellow/40 border border-cockpit-yellow/60 rounded-lg text-cockpit-yellow text-xs hover:bg-cockpit-yellow/60 transition-colors"
        >
          <AlertCircle size={14} className="shrink-0" />
          <span>{t('expenses.didYouMean', { name: suggestion.name })}</span>
        </button>
      )}

      {open && (
        <div className="absolute z-20 mt-1 w-full bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl max-h-72 overflow-y-auto">
          {results.length === 0 && !showTypedOption && !loading && (
            <div className="px-3 py-3 text-sm text-neutral-500">
              {t('expenses.noPayeesFound', { defaultValue: 'No matching payees. Type a name to use it.' })}
            </div>
          )}
          {results.map((p, idx) => {
            const isActive = idx === activeIdx;
            const isEmployee = p.source === 'employee';
            return (
              <button
                key={`${p.source}-${p.name}-${idx}`}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => handleSelect(p)}
                onMouseEnter={() => setActiveIdx(idx)}
                className={`w-full flex items-center justify-between gap-3 px-3 py-2 text-left transition-colors ${
                  isActive ? 'bg-brand-600/20 text-white' : 'text-neutral-200 hover:bg-neutral-800'
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  {isEmployee
                    ? <UserCircle2 size={14} className="text-brand-400 shrink-0" />
                    : <User size={14} className="text-neutral-500 shrink-0" />}
                  <span className="text-sm truncate">{p.name}</span>
                </div>
                {isEmployee && (
                  <span className="text-[10px] uppercase tracking-wider text-brand-400/80 shrink-0">
                    {t('expenses.payeeEmployee', { defaultValue: 'employee' })}
                  </span>
                )}
              </button>
            );
          })}
          {showTypedOption && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={handleAcceptTyped}
              onMouseEnter={() => setActiveIdx(results.length)}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left border-t border-neutral-800 transition-colors ${
                activeIdx === results.length ? 'bg-brand-600/20' : 'hover:bg-neutral-800'
              } text-brand-300`}
            >
              <User size={14} />
              <span className="text-sm">
                {t('expenses.usePayee', { defaultValue: 'Use "{{name}}"', name: trimmed })}
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default PayeeCombobox;
