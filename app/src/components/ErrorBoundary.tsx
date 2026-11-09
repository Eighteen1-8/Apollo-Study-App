import { Component, ReactNode } from 'react';
import { ErrorCode } from './ErrorText';
import { logError } from '../log';

/** Keeps one broken pane from blanking the whole window: shows what failed with a retry, and logs it. Give it a
 * `resetKey` (e.g. the open document) so switching to something else clears the error. */
export default class ErrorBoundary extends Component<{ name: string; children: ReactNode; resetKey?: unknown; compact?: boolean; onClose?: () => void },
  { error: Error | null; key: unknown }> {
  state = { error: null as Error | null, key: this.props.resetKey };

  static getDerivedStateFromProps(props: { resetKey?: unknown }, state: { error: Error | null; key: unknown }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    logError(`view:${this.props.name}`, Object.assign(error, { stack: `${error.stack ?? ''}
${info.componentStack ?? ''}` }));
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className={`crash${this.props.compact ? ' crash-compact' : ''}`} role="alert">
        <div className="crash-title">{this.props.name} ran into a problem</div>
        <div className="crash-msg">{error.message || String(error)} <ErrorCode code="APO-UI-601" context={`${this.props.name}: ${error.message}`} /></div>
        <span className="crash-actions">
          <button className="btn btn-sm" onClick={() => this.setState({ error: null })}>Try again</button>
          {this.props.onClose && <button className="btn btn-sm" onClick={this.props.onClose}>Close</button>}
        </span>
        <div className="crash-note">The details were saved to the app's log.</div>
      </div>
    );
  }
}
