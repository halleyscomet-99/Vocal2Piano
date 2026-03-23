import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './App.css'

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  componentDidCatch(error, info) {
    this.setState({ error: error.message + '\n\n' + info.componentStack })
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{
          padding: 40, fontFamily: 'monospace',
          background: '#1a0000', color: '#ff6060',
          minHeight: '100vh', whiteSpace: 'pre-wrap'
        }}>
          <h2>React Error (white screen cause):</h2>
          <pre>{this.state.error}</pre>
        </div>
      )
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)

