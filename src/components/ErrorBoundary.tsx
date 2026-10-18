import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[EnigmaOS] Uncaught exception:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="fixed top-2 left-1/2 -translate-x-1/2 z-50 p-4 bg-black/95 rounded-2xl text-[#b82a2a] border border-[#b82a2a]/40 max-w-lg shadow-[0_20px_50px_rgba(0,0,0,0.95)] pointer-events-auto">
          <div className="flex items-center gap-2 mb-2">
            <span className="w-3 h-3 rounded-full bg-[#b82a2a] animate-ping" />
            <h2 className="text-sm font-bold tracking-wide uppercase text-white">
              Error de Renderizado en TopBar
            </h2>
          </div>
          <p className="text-xs text-white/80 font-mono-num mb-3">
            {this.state.error?.message || 'Error desconocido'}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="px-3 py-1 bg-[#b82a2a]/20 hover:bg-[#b82a2a]/30 text-white border border-[#b82a2a]/40 rounded-lg text-xs font-semibold transition-colors"
          >
            Reintentar inicialización
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
