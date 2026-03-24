import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { X } from 'lucide-react';

type ToastType = 'success' | 'error' | 'warning' | 'info';

interface Toast {
  id: string;
  message: string;
  type: ToastType;
}

interface ToastContextType {
  addToast: (message: string, type?: ToastType, durationMs?: number) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

let nextId = 0;

export const ToastProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const addToast = useCallback((message: string, type: ToastType = 'info', durationMs = 5000) => {
    const id = `toast-${++nextId}`;
    setToasts(prev => [...prev, { id, message, type }]);
    if (durationMs > 0) {
      setTimeout(() => removeToast(id), durationMs);
    }
  }, [removeToast]);

  const STYLE_MAP: Record<ToastType, string> = {
    success: 'border-green-600 bg-green-900/40 text-green-300',
    error: 'border-red-600 bg-red-900/40 text-red-300',
    warning: 'border-amber-600 bg-amber-900/40 text-amber-300',
    info: 'border-brand-600 bg-brand-900/40 text-brand-300',
  };

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      {/* Toast Container */}
      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-[60] space-y-2 max-w-sm">
          {toasts.map(toast => (
            <div
              key={toast.id}
              className={`flex items-center gap-3 px-4 py-3 rounded-lg border shadow-lg backdrop-blur-sm ${STYLE_MAP[toast.type]}`}
            >
              <p className="text-sm font-medium flex-1">{toast.message}</p>
              <button
                onClick={() => removeToast(toast.id)}
                className="flex-shrink-0 opacity-60 hover:opacity-100 transition-opacity"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
};

export const useToast = (): ToastContextType => {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
};
