import React, { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

const RELOAD_FLAG = 'errorBoundary:chunkReloadAttempted';

function isChunkLoadError(error: Error | null): boolean {
  if (!error) return false;
  const msg = error.message || '';
  const name = error.name || '';
  return (
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg) ||
    /Loading chunk \d+ failed/i.test(msg) ||
    /Loading CSS chunk/i.test(msg) ||
    name === 'ChunkLoadError'
  );
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);

    if (isChunkLoadError(error) && !sessionStorage.getItem(RELOAD_FLAG)) {
      sessionStorage.setItem(RELOAD_FLAG, '1');
      window.location.reload();
    }
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      const chunkError = isChunkLoadError(this.state.error);
      return (
        <div className="min-h-screen flex items-center justify-center bg-neutral-950 p-8">
          <div className="max-w-lg w-full bg-neutral-900 rounded-xl border border-cockpit-red/40 p-6">
            <h2 className="text-xl font-bold text-cockpit-out-text mb-2">
              {chunkError ? 'A new version is available' : 'Something went wrong'}
            </h2>
            <pre className="text-sm text-neutral-300 whitespace-pre-wrap break-words mb-4">
              {chunkError
                ? 'This screen was updated since you last loaded the app. Reload to get the latest version.'
                : this.state.error?.message}
            </pre>
            <div className="flex gap-2">
              {chunkError && (
                <button
                  onClick={() => {
                    sessionStorage.removeItem(RELOAD_FLAG);
                    window.location.reload();
                  }}
                  className="px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-500"
                >
                  Reload
                </button>
              )}
              <button
                onClick={() => {
                  this.setState({ hasError: false, error: null });
                  window.location.hash = '#/pos';
                }}
                className={`px-4 py-2 rounded-lg ${
                  chunkError
                    ? 'bg-neutral-800 text-neutral-200 hover:bg-neutral-700'
                    : 'bg-brand-600 text-white hover:bg-brand-500'
                }`}
              >
                Back to POS
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
