import React, { useState } from 'react'
import { LiveMode } from './components/LiveMode'
import { FileMode } from './components/FileMode'

export default function App() {
  const [mode, setMode] = useState('live')

  return (
    <div className="app">
      <header className="app-header">
        <div className="logo">
          <div className="logo-mark">V2P</div>
          <div className="logo-text">
            <span className="logo-main">Voice2Piano</span>
            <span className="logo-sub">pitch detection · midi export</span>
          </div>
        </div>
        <nav className="mode-tabs">
          <button
            className={`tab ${mode === 'live' ? 'active' : ''}`}
            onClick={() => setMode('live')}
          >
            <span className="tab-dot" />
            Live
          </button>
          <button
            className={`tab ${mode === 'file' ? 'active' : ''}`}
            onClick={() => setMode('file')}
          >
            <span className="tab-icon">↑</span>
            File
          </button>
        </nav>
      </header>

      <div className="mode-desc">
        {mode === 'live'
          ? 'mic → real-time pitch detection → MIDI  ·  auto-saves to files/output/'
          : 'upload audio → classify source → Basic Pitch / pYIN → MIDI  ·  auto-saves to files/output/'}
      </div>

      <main>{mode === 'live' ? <LiveMode /> : <FileMode />}</main>

      <footer className="app-footer">
        Voice2Piano · Layer 1 · pYIN + onset detection · v2.0
      </footer>
    </div>
  )
}
