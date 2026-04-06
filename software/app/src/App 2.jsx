/**
 * App.jsx
 * -------
 * Root component for Voice2Piano web app.
 * Renders a tab switcher between Live (mic) and File (upload) modes.
 */

import React, { useState } from 'react'
import { LiveMode } from './components/LiveMode'
import { FileMode } from './components/FileMode'

export default function App() {
  const [mode, setMode] = useState('live') // 'live' | 'file'

  return (
    <div className="app">
      {/* Header */}
      <header className="app-header">
        <div className="logo">
          <span className="logo-main">Voice2Piano</span>
          <span className="logo-sub">pitch detection · MIDI export</span>
        </div>

        <nav className="mode-tabs">
          <button
            className={`tab ${mode === 'live' ? 'active' : ''}`}
            onClick={() => setMode('live')}
          >
            <span className="tab-icon">●</span> Live
          </button>
          <button
            className={`tab ${mode === 'file' ? 'active' : ''}`}
            onClick={() => setMode('file')}
          >
            <span className="tab-icon">↑</span> File
          </button>
        </nav>
      </header>

      {/* Mode description */}
      <div className="mode-desc">
        {mode === 'live'
          ? 'Real-time pitch detection from microphone → MIDI'
          : 'Upload audio file → convert via Basic Pitch → MIDI'}
      </div>

      {/* Main content */}
      <main className="app-main">
        {mode === 'live' ? <LiveMode /> : <FileMode />}
      </main>

      <footer className="app-footer">
        Voice2Piano · Layer 1 · pYIN + onset detection
      </footer>
    </div>
  )
}
