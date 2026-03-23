# Voice2Piano — Web Frontend

Real-time and file-based pitch detection to MIDI.
Frontend: React + Vite → Vercel
Backend: FastAPI + Basic Pitch → Render

---

## Quickstart (local)

```bash
# Frontend
npm install
npm run dev
# → http://localhost:3000

# Backend (separate terminal)
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Set `VITE_BACKEND_URL=http://localhost:8000` in a `.env` file at the project root.

---

## Deploy Frontend → Vercel

1. Push this repo to GitHub.
2. Go to [vercel.com](https://vercel.com) → New Project → Import repo.
3. Framework Preset: **Vite**
4. Build Command: `npm run build`
5. Output Directory: `dist`
6. Add Environment Variable:
   - Key: `VITE_BACKEND_URL`
   - Value: your Render backend URL (see below)
7. Deploy. Vercel gives you a free permanent URL.

---

## Deploy Backend → Render

1. Go to [render.com](https://render.com) → New Web Service.
2. Connect your GitHub repo.
3. Settings:
   - **Root Directory**: `backend`
   - **Environment**: Python 3
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `uvicorn main:app --host 0.0.0.0 --port $PORT`
4. Free tier is fine (spins down after inactivity — first request after sleep takes ~30s).
5. Copy the service URL, e.g. `https://voice2piano-api.onrender.com`
6. Paste into Vercel env var `VITE_BACKEND_URL`.

---

## Architecture

```
Browser (Vercel)
  ├── Live Mode
  │   ├── Web Audio API → autocorrelation pitch detection
  │   ├── MIDI note recording (@tonejs/midi)
  │   └── MIDI playback (Tone.js)
  └── File Mode
      ├── Upload audio → POST /convert (Render)
      ├── Backend runs Basic Pitch (Spotify model)
      └── Returns MIDI → playback in browser
```

---

## Tuning

In `src/hooks/usePitchDetect.js`:

| Constant | Effect |
|----------|--------|
| RMS threshold `0.008` | Lower = more sensitive to quiet input |
| Min freq `21` (MIDI A0) | Change to restrict piano range |

In `Voice2MIDI.py`:

| Constant | Effect |
|----------|--------|
| `ONSET_THRESHOLD` | Lower = catches faster/softer notes |
| `CONF_MIN` | Lower = more notes, more octave errors |
| `OCTAVE_SHIFT` | Set to 0 if octave correction not needed |
