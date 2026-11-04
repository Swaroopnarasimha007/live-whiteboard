import { Component, type ErrorInfo, type ReactNode } from 'react';

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Application error', error, info.componentStack);
  }

  render() {
    if (this.state.failed) {
      return (
        <main role="alert">
          <h1>Unable to display the application</h1>
          <p>Reload the page to try again.</p>
        </main>
      );
    }
    return this.props.children;
  }
}
