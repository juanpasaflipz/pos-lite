import React, { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
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
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="min-h-screen flex items-center justify-center bg-neutral-950 p-8">
          <div className="max-w-lg w-full bg-neutral-900 rounded-xl border border-red-800 p-6">
            <h2 className="text-xl font-bold text-red-400 mb-2">Something went wrong</h2>
            <pre className="text-sm text-neutral-300 whitespace-pre-wrap break-words mb-4">
              {this.state.error?.message}
            </pre>
            <button
              onClick={() => {
                this.setState({ hasError: false, error: null });
                window.location.hash = '#/pos';
              }}
              className="px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-500"
            >
              Back to POS
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
