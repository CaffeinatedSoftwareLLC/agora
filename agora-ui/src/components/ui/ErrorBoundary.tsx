import { Component, type ReactNode, type ErrorInfo } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex items-center justify-center h-screen p-8">
          <div className="max-w-lg text-center">
            <h1 className="text-xl font-bold text-danger mb-2">Something went wrong</h1>
            <pre className="text-sm text-text-muted bg-surface border border-border rounded p-4 text-left overflow-auto max-h-64 whitespace-pre-wrap">
              {this.state.error.message}
              {'\n\n'}
              {this.state.error.stack}
            </pre>
            <button
              onClick={() => {
                this.setState({ error: null });
                window.location.href = '/app';
              }}
              className="mt-4 px-4 py-2 bg-primary text-text rounded hover:bg-primary-hover"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
