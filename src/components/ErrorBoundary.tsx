import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

// No error boundary existed anywhere in the app — a render throw in any panel white-screened
// the whole simulator with nothing but a blank page and a console stack trace. This wraps the
// app shell so a defect in one panel degrades to a visible, recoverable error card instead.
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] caught render error:', error, info.componentStack)
  }

  handleReset = () => {
    this.setState({ error: null })
  }

  render() {
    if (this.state.error) {
      return (
        <div
          role="alert"
          data-testid="error-boundary-fallback"
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: 12, background: '#0d1117', color: '#e6edf3',
            fontFamily: 'var(--font-mono, monospace)', padding: 24, textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 14, color: '#ff4444', letterSpacing: '0.08em' }}>
            ⚠ SIMULATOR ENCOUNTERED AN ERROR
          </div>
          <div style={{ fontSize: 11, color: '#8899aa', maxWidth: 480 }}>
            {this.state.error.message}
          </div>
          <div style={{ fontSize: 9, color: '#556677' }}>
            Simulation-only build error — no real flight data affected.
          </div>
          <button
            className="btn primary"
            onClick={this.handleReset}
            style={{ marginTop: 8, padding: '6px 14px' }}
          >
            RESET UI
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
