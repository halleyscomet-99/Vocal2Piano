/**
 * saveUtils.js
 * ------------
 * Save files to the project's files/input or files/output directory
 * via the Python server's /save endpoints.
 *
 * This avoids browser auto-download to ~/Downloads.
 * Files are saved server-side to software/files/output/.
 */

const BACKEND = import.meta.env.VITE_BACKEND_URL || ''

/**
 * Save a MIDI Blob to software/files/output/<filename>
 * @param {Blob}   blob
 * @param {string} filename   e.g. "live_2026-03-23_output.mid"
 */
export async function saveMidiToProject(blob, filename) {
  if (!BACKEND || !blob) return
  const form = new FormData()
  form.append('file', blob, filename)
  form.append('filename', filename)
  try {
    await fetch(`${BACKEND}/save/midi`, { method: 'POST', body: form })
  } catch (err) {
    console.warn('saveMidiToProject failed:', err)
  }
}

/**
 * Save an audio Blob to software/files/output/<filename>
 * @param {Blob}   blob
 * @param {string} filename   e.g. "live_2026-03-23_recording.webm"
 */
export async function saveAudioToProject(blob, filename) {
  if (!BACKEND || !blob) return
  const form = new FormData()
  form.append('file', blob, filename)
  form.append('filename', filename)
  try {
    await fetch(`${BACKEND}/save/audio`, { method: 'POST', body: form })
  } catch (err) {
    console.warn('saveAudioToProject failed:', err)
  }
}

/**
 * Trigger a browser download of a blob.
 * Use this only when the user explicitly clicks a download button.
 */
export function browserDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
