/**
 * FileMode.jsx  v6
 * All duration values default to 0, never undefined.
 * No stale closures. SSE fully wrapped in try-catch.
 */

import React, { useState, useRef, useCallback, useEffect } from 'react'
import { Piano88 } from './Piano88'
import { Waveform } from './Waveform'
import { parseMidiNotes, downloadMidi, playMidiNotes } from '../utils/midiUtils'

const BACKEND = import.meta.env.VITE_BACKEND_URL || ''
const ACCEPTED = '.mp3,.wav,.flac,.m4a,.ogg,.aiff'
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']

function noteLabel(midi) {
  if (midi == null) return null
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`
}

const SOURCE_OPTIONS = [
  { id:'auto',         label:'Auto-detect',           icon:'🔍', desc:'Analyse and choose best algorithm' },
  { id:'voice',        label:'Voice only',             icon:'🎤', desc:'Pure singing → pYIN melody MIDI' },
  { id:'instrumental', label:'Instrumental',           icon:'🎸', desc:'Backing track → Basic Pitch polyphonic' },
  { id:'mixed',        label:'Mixed (vocals + music)', icon:'🎵', desc:'Full song → Demucs → piano MIDI' },
]

const SOURCE_META = {
  voice:        { color:'#3B6CF4', label:'Voice' },
  instrumental: { color:'#F59E0B', label:'Instrumental' },
  mixed:        { color:'#8B5CF6', label:'Mixed' },
  auto:         { color:'#22C55E', label:'Auto' },
}

const STEP_ICONS = { load:'📂', classify:'🔍', separate:'✂️', transcribe:'🎹', output:'✅' }
const STATUS_COLORS = { running:'#F59E0B', done:'#22C55E', error:'#EF4444', skipped:'#9CA3AF' }

function fmt(sec) {
  // Safe formatter -- returns '' if sec is falsy
  if (!sec || sec <= 0) return ''
  return `${Number(sec).toFixed(1)}s`
}

export function FileMode() {
  const [sourceType, setSourceType] = useState('auto')
  const [dragging, setDragging] = useState(false)
  const [fileName, setFileName] = useState(null)
  const [stem, setStem] = useState(null)
  const [status, setStatus] = useState('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [detectedSource, setDetectedSource] = useState(null)
  const [pipelineSteps, setPipelineSteps] = useState({})
  const [classifyData, setClassifyData] = useState(null)
  const [midiNotes, setMidiNotes] = useState([])
  const [midiBlob, setMidiBlob] = useState(null)
  const [uploadedFile, setUploadedFile] = useState(null)
  const [vocalsUrl, setVocalsUrl] = useState(null)
  const [accumUrl, setAccumUrl] = useState(null)

  const inputRef = useRef(null)

  // Audio elements
  const audioRefA = useRef(null)
  const audioRefC = useRef(null)
  const audioRefD = useRef(null)
  const urlARef = useRef(null)

  // Track durations -- always initialised to 0
  const [durA, setDurA] = useState(0)
  const [durC, setDurC] = useState(0)
  const [durD, setDurD] = useState(0)

  // Playback times
  const [timeA, setTimeA] = useState(0)
  const [timeC, setTimeC] = useState(0)
  const [timeD, setTimeD] = useState(0)

  // Playing flags
  const [playingA, setPlayingA] = useState(false)
  const [playingB, setPlayingB] = useState(false)
  const [playingC, setPlayingC] = useState(false)
  const [playingD, setPlayingD] = useState(false)

  const rafA = useRef(null)
  const rafC = useRef(null)
  const rafD = useRef(null)

  const [midiNote, setMidiNote] = useState(null)
  const cancelMidiRef = useRef(null)
  const [comparing, setComparing] = useState(false)

  const uniqueNotes = [...new Set(midiNotes.map(n => n.midi))].sort((a,b) => a-b)

  useEffect(() => {
    return () => { if (urlARef.current) URL.revokeObjectURL(urlARef.current) }
  }, [])

  // ---- Audio helpers (stable functions, use refs only) ----

  function playAudio(ref, rafRef, setTime, setPlaying) {
    if (!ref.current) return
    ref.current.currentTime = 0
    ref.current.play().catch(() => {})
    setPlaying(true)
    const tick = () => {
      if (!ref.current) return
      setTime(ref.current.currentTime)
      if (!ref.current.paused) {
        rafRef.current = requestAnimationFrame(tick)
      } else { setPlaying(false); setTime(0) }
    }
    rafRef.current = requestAnimationFrame(tick)
  }

  function stopAudio(ref, rafRef, setTime, setPlaying) {
    if (ref.current) { ref.current.pause(); ref.current.currentTime = 0 }
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    setPlaying(false); setTime(0)
  }

  function loadAudio(ref, url, setDur) {
    if (!ref.current || !url) return
    ref.current.src = url
    ref.current.load()
    ref.current.onloadedmetadata = () => {
      if (ref.current) setDur(ref.current.duration || 0)
    }
  }

  // ---- Stop all ----
  const stopAll = useCallback(() => {
    stopAudio(audioRefA, rafA, setTimeA, setPlayingA)
    stopAudio(audioRefC, rafC, setTimeC, setPlayingC)
    stopAudio(audioRefD, rafD, setTimeD, setPlayingD)
    if (cancelMidiRef.current) cancelMidiRef.current()
    setPlayingB(false); setMidiNote(null); setComparing(false)
  }, [])

  // ---- Track play handlers ----
  const handlePlayA = useCallback(() => {
    if (playingA) { stopAudio(audioRefA, rafA, setTimeA, setPlayingA); return }
    stopAll(); playAudio(audioRefA, rafA, setTimeA, setPlayingA)
  }, [playingA, stopAll])

  const handlePlayC = useCallback(() => {
    if (playingC) { stopAudio(audioRefC, rafC, setTimeC, setPlayingC); return }
    stopAll(); playAudio(audioRefC, rafC, setTimeC, setPlayingC)
  }, [playingC, stopAll])

  const handlePlayD = useCallback(() => {
    if (playingD) { stopAudio(audioRefD, rafD, setTimeD, setPlayingD); return }
    stopAll(); playAudio(audioRefD, rafD, setTimeD, setPlayingD)
  }, [playingD, stopAll])

  const handlePlayB = useCallback(async () => {
    if (playingB) { stopAll(); return }
    if (!midiNotes.length) return
    stopAll()
    setPlayingB(true)
    cancelMidiRef.current = await playMidiNotes(
      midiNotes,
      midi => setMidiNote(midi),
      () => { setPlayingB(false); setMidiNote(null) }
    )
  }, [playingB, midiNotes, stopAll])

  const handleCompare = useCallback(async () => {
    if (comparing) { stopAll(); return }
    stopAll(); setComparing(true)
    playAudio(audioRefA, rafA, setTimeA, setPlayingA)
    setPlayingB(true)
    cancelMidiRef.current = await playMidiNotes(
      midiNotes,
      midi => setMidiNote(midi),
      () => { setPlayingB(false); setMidiNote(null); setComparing(false) }
    )
  }, [comparing, midiNotes, stopAll])

  // ---- File processing ----
  const processFile = useCallback(async (file) => {
    if (!BACKEND) {
      setStatus('error')
      setErrorMsg('Backend not running.\n\nStart:\npython software/engine/Vocal2MIDI_file.py --server\n\n.env:\nVITE_BACKEND_URL=http://localhost:8000')
      return
    }

    const fileStem = file.name.replace(/\.[^.]+$/, '')
    setFileName(file.name); setStem(fileStem)
    setStatus('uploading')
    setMidiNotes([]); setMidiBlob(null); setMidiNote(null)
    setPipelineSteps({}); setDetectedSource(null); setClassifyData(null)
    setVocalsUrl(null); setAccumUrl(null)
    setUploadedFile(file)
    setDurA(0); setDurC(0); setDurD(0)
    setTimeA(0); setTimeC(0); setTimeD(0)

    // Track A persistent URL
    if (urlARef.current) URL.revokeObjectURL(urlARef.current)
    const fileUrl = URL.createObjectURL(file)
    urlARef.current = fileUrl
    loadAudio(audioRefA, fileUrl, setDurA)

    try {
      const form = new FormData()
      form.append('file', file)
      form.append('source_type', sourceType)

      const res = await fetch(`${BACKEND}/convert/stream`, { method:'POST', body:form })
      if (!res.ok) throw new Error(`Server ${res.status}: ${await res.text()}`)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n\n')
        buf = lines.pop() || ''

        for (const chunk of lines) {
          const dl = chunk.split('\n').find(l => l.startsWith('data: '))
          if (!dl) continue
          try {
            const evt = JSON.parse(dl.slice(6))

            if (evt.type === 'step') {
              setPipelineSteps(prev => ({ ...prev, [evt.step]: evt }))
              if (evt.step === 'classify' && evt.status === 'done') {
                setClassifyData(evt)
                if (evt.result) setDetectedSource(evt.result)
              }
              // Grab vocals/accom file names from separate step
              if (evt.step === 'separate' && evt.status === 'done') {
                if (evt.vocals_file) {
                  const url = `${BACKEND}/files/${evt.vocals_file}`
                  setVocalsUrl(url)
                  loadAudio(audioRefC, url, setDurC)
                }
                if (evt.accom_file) {
                  const url = `${BACKEND}/files/${evt.accom_file}`
                  setAccumUrl(url)
                  loadAudio(audioRefD, url, setDurD)
                }
              }
            } else if (evt.type === 'done') {
              setDetectedSource(evt.source_type || null)

              if (evt.vocals_file) {
                const url = `${BACKEND}/files/${evt.vocals_file}`
                setVocalsUrl(url)
                loadAudio(audioRefC, url, setDurC)
              }
              if (evt.accom_file) {
                const url = `${BACKEND}/files/${evt.accom_file}`
                setAccumUrl(url)
                loadAudio(audioRefD, url, setDurD)
              }

              if (evt.midi_file) {
                try {
                  const midiRes = await fetch(`${BACKEND}/files/${evt.midi_file}`)
                  const blob = await midiRes.blob()
                  setMidiBlob(blob)
                  const notes = await parseMidiNotes(blob)
                  setMidiNotes(notes)
                  setStatus('done')
                  downloadMidi(blob, `${fileStem}_output.mid`)
                } catch (err) {
                  setStatus('error')
                  setErrorMsg(`Failed to fetch MIDI: ${err.message}`)
                }
              }
            } else if (evt.type === 'error') {
              setStatus('error')
              setErrorMsg(evt.detail || 'Unknown server error')
            }
          } catch (parseErr) {
            console.warn('SSE parse error:', parseErr)
          }
        }
      }
    } catch (err) {
      setStatus('error')
      setErrorMsg(err.message)
    }
  }, [sourceType])

  const handleDrop = useCallback(e => {
    e.preventDefault(); setDragging(false)
    const f = e.dataTransfer.files[0]; if (f) processFile(f)
  }, [processFile])

  const handleInput = useCallback(e => {
    const f = e.target.files[0]; if (f) processFile(f)
  }, [processFile])

  const totalDur = midiNotes.length
    ? (midiNotes[midiNotes.length-1].time + midiNotes[midiNotes.length-1].duration).toFixed(1)
    : '0'

  const stepOrder = ['load','classify','separate','transcribe','output']
  const isMixed = detectedSource === 'mixed'

  return (
    <div className="mode-panel">

      {/* Source selector */}
      {status === 'idle' && (
        <div className="card">
          <div className="card-header"><span className="card-title">Source Type</span></div>
          <div className="source-selector">
            {SOURCE_OPTIONS.map(opt => (
              <button key={opt.id}
                className={`source-option ${sourceType === opt.id ? 'selected' : ''}`}
                onClick={() => setSourceType(opt.id)}>
                <span className="mode-icon">{opt.icon}</span>
                <span className="mode-label">{opt.label}</span>
                <span className="mode-desc">{opt.desc}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Drop zone */}
      <div
        className={`drop-zone ${dragging?'drag-over':''} ${status==='done'?'done':''} ${status==='error'?'errored':''}`}
        onDragOver={e=>{e.preventDefault();setDragging(true)}}
        onDragLeave={()=>setDragging(false)}
        onDrop={handleDrop}
        onClick={()=>inputRef.current?.click()}
      >
        <input ref={inputRef} type="file" accept={ACCEPTED} style={{display:'none'}} onChange={handleInput}/>
        {status==='idle' && (<><div className="drop-icon">♩</div><div className="drop-primary">Drop audio file here</div><div className="drop-secondary">MP3 · WAV · FLAC · M4A · OGG</div></>)}
        {status==='uploading' && (<><div className="drop-icon spin">⟳</div><div className="drop-primary">Processing…</div><div className="drop-secondary">{fileName}</div></>)}
        {status==='done' && (<><div className="drop-icon ok">✓</div><div className="drop-primary">{fileName}</div><div className="drop-secondary">{midiNotes.length} notes · {totalDur}s · click to replace</div></>)}
        {status==='error' && (<><div className="drop-icon err">!</div><div className="drop-primary">Error</div><div className="drop-secondary" style={{whiteSpace:'pre-line'}}>{errorMsg}</div></>)}
      </div>

      {/* Pipeline */}
      {(status==='uploading'||status==='done') && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Pipeline</span>
            {detectedSource && SOURCE_META[detectedSource] && (
              <span className="card-badge" style={{background:SOURCE_META[detectedSource].color+'22',color:SOURCE_META[detectedSource].color}}>
                {SOURCE_META[detectedSource].label}
              </span>
            )}
          </div>
          <div className="pipeline-viz">
            <div className="pipeline-steps">
              {stepOrder.map(key => {
                const s = pipelineSteps[key]
                const st = s?.status || 'pending'
                return (
                  <div key={key} className="pipeline-step">
                    <div className="step-icon" style={{background:STATUS_COLORS[st]||'var(--border2)',opacity:st==='pending'?0.25:1}}>
                      {STEP_ICONS[key]}
                    </div>
                    <div className="step-label">{key}</div>
                    {s?.detail && <div className="step-detail">{s.detail}</div>}
                  </div>
                )
              })}
            </div>
            {classifyData && (
              <div className="classify-metrics">
                {[
                  {label:'Voice ratio', val:classifyData.voice_ratio||0, display:`${((classifyData.voice_ratio||0)*100).toFixed(0)}%`, color:(classifyData.voice_ratio||0)>0.35?'#3B6CF4':'#9CA3AF'},
                  {label:'Voice conf',  val:classifyData.voiced_conf||0,  display:(classifyData.voiced_conf||0).toFixed(2), color:(classifyData.voiced_conf||0)>0.45?'#22C55E':'#F59E0B'},
                  {label:'Spectral BW', val:Math.min((classifyData.spectral_bw||0)/4000,1), display:`${(classifyData.spectral_bw||0).toFixed(0)} Hz`, color:(classifyData.spectral_bw||0)<2500?'#22C55E':'#8B5CF6'},
                ].map(m=>(
                  <div key={m.label} className="metric-row">
                    <span className="metric-label">{m.label}</span>
                    <div className="metric-bar-wrap"><div className="metric-bar" style={{width:`${m.val*100}%`,background:m.color}}/></div>
                    <span className="metric-val">{m.display}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Source badge */}
      {detectedSource && SOURCE_META[detectedSource] && (
        <div className="source-badge" style={{'--badge-color':SOURCE_META[detectedSource].color}}>
          <div className="badge-dot"/>
          <span className="badge-label">{SOURCE_META[detectedSource].label}</span>
        </div>
      )}

      {/* Tracks */}
      {status==='done' && midiNotes.length>0 && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">
              {isMixed ? '4 Tracks · Original + MIDI + Vocals + Accompaniment' : 'Compare · Original vs MIDI'}
            </span>
          </div>
          <div className="compare-section">

            {/* Track A */}
            <div className="track-block">
              <div className="track-header">
                <div className="track-color-bar" style={{background:'#3B6CF4'}}/>
                <span className="track-name">Track A — {fileName}</span>
                <span className="track-meta">{fmt(durA)}</span>
                <button className="track-play-btn" style={{background:'#3B6CF4'}} onClick={handlePlayA} disabled={!uploadedFile}>
                  {playingA?'■':'▶'}
                </button>
              </div>
              <div className="track-wave">
                <Waveform audioBlob={uploadedFile} currentTime={timeA} duration={durA} color="#3B6CF4" label="AUDIO"/>
              </div>
            </div>

            {/* Track B (MIDI) */}
            <div className="track-block">
              <div className="track-header">
                <div className="track-color-bar" style={{background:'#22C55E'}}/>
                <span className="track-name">Track B — {stem}_output.mid</span>
                <span className="track-meta">{midiNotes.length} notes</span>
                <button className="track-play-btn" style={{background:'#22C55E'}} onClick={handlePlayB} disabled={!midiNotes.length}>
                  {playingB?'■':'▶'}
                </button>
              </div>
              <div className="track-wave">
                <Waveform isActive={playingB} color="#22C55E" label="MIDI"/>
              </div>
              <Piano88 activeNote={midiNote}/>
              <div className="note-chips">
                {uniqueNotes.map(midi=>{
                  const count = midiNotes.filter(n=>n.midi===midi).length
                  return (
                    <div key={midi} className={`note-chip ${midiNote===midi?'lit':''}`}>
                      <span className="chip-name">{noteLabel(midi)}</span>
                      <span className="chip-count">×{count}</span>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Track C (vocals) */}
            {vocalsUrl && (
              <div className="track-block">
                <div className="track-header">
                  <div className="track-color-bar" style={{background:'#F472B6'}}/>
                  <span className="track-name">Track C — Vocals</span>
                  <span className="track-meta">{fmt(durC)}</span>
                  <button className="track-play-btn" style={{background:'#F472B6'}} onClick={handlePlayC}>
                    {playingC?'■':'▶'}
                  </button>
                </div>
                <div className="track-wave">
                  <Waveform currentTime={timeC} duration={durC} color="#F472B6" label="VOCALS"/>
                </div>
              </div>
            )}

            {/* Track D (accompaniment) */}
            {accumUrl && (
              <div className="track-block">
                <div className="track-header">
                  <div className="track-color-bar" style={{background:'#FB923C'}}/>
                  <span className="track-name">Track D — Accompaniment</span>
                  <span className="track-meta">{fmt(durD)}</span>
                  <button className="track-play-btn" style={{background:'#FB923C'}} onClick={handlePlayD}>
                    {playingD?'■':'▶'}
                  </button>
                </div>
                <div className="track-wave">
                  <Waveform currentTime={timeD} duration={durD} color="#FB923C" label="ACCOM"/>
                </div>
              </div>
            )}

            <div className="compare-btn-row">
              <button className="compare-toggle" onClick={handleCompare} disabled={!midiNotes.length}>
                ⇄ {comparing?'Stop':'Play A + B Together'}
              </button>
              <button className="btn btn-outline" style={{marginLeft:8}}
                onClick={()=>downloadMidi(midiBlob,`${stem}_output.mid`)}>
                ↓ Download MIDI
              </button>
            </div>
          </div>
        </div>
      )}

      <audio ref={audioRefA} style={{display:'none'}}/>
      <audio ref={audioRefC} style={{display:'none'}}/>
      <audio ref={audioRefD} style={{display:'none'}}/>
    </div>
  )
}