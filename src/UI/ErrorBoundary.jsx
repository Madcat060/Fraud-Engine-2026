/**
 * Error Boundary – catches render errors in children and shows a fallback UI
 * so the rest of the app (e.g. case list) does not unmount.
 */
import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
  }

  render() {
    if (this.state.hasError && this.state.error) {
      const dismiss = () => {
        this.setState({ hasError: false, error: null });
        if (typeof this.props.onDismiss === 'function') this.props.onDismiss();
      };
      return (
        <div className="p-4 bg-red-100 text-red-700">
          <h2>Profile Render Error</h2>
          <pre>{this.state.error.toString()}</pre>
          <button type="button" onClick={dismiss}>
            Dismiss
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
