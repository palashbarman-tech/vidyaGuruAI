
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import multer from "multer";
import officeParser from "officeparser";
import fs from "fs";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, "..", "tmp_uploads"),
    filename: (req, file, cb) => cb(null, Date.now() + "-" + Math.round(Math.random()*1e9) + path.extname(file.originalname)),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

app.post("/api/parse-pptx", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  try {
    const text = await officeParser.parseOfficeAsync(req.file.path);
    res.json({ text });
  } catch (err) {
    console.error("PPTX parse error:", err);
    res.status(500).json({ error: "Could not read that PPTX file: " + err.message });
  } finally {
    fs.unlink(req.file.path, () => {}); // clean up temp file either way
  }
});

app.post("/api/teach", async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: "GEMINI_API_KEY is not set. Add it to your .env file." });
  }
  console.log("→ /api/teach: sending request to Gemini...");
  const startedAt = Date.now();
  try {
    const { system, messages, wantJSON } = req.body;
    const userText = (messages || []).map(m => m.content).join("\n");

    const generationConfig = { temperature: 0.7, maxOutputTokens: 8192 };
    if (wantJSON) {
      generationConfig.responseMimeType = "application/json";
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30s

    let upstream;
    try {
      upstream = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: system ? { parts: [{ text: system }] } : undefined,
          contents: [{ role: "user", parts: [{ text: userText }] }],
          generationConfig,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    console.log(`← /api/teach: Gemini responded after ${Date.now() - startedAt}ms, status ${upstream.status}`);
    const data = await upstream.json();
    if (!upstream.ok) {
      return res.status(upstream.status).json(data);
    }
    const finishReason = data.candidates?.[0]?.finishReason;
    if (finishReason === "MAX_TOKENS") {
      console.warn("Gemini response was cut off at the token limit.");
    }
    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join("\n") || "";
    res.json({ content: [{ type: "text", text }] });
  } catch (err) {
    if (err.name === "AbortError") {
      console.error("✗ /api/teach: request to Gemini timed out after 30s (no response at all — likely a network/firewall block).");
      return res.status(504).json({
        error: "Timed out waiting for Gemini (30s, no response). This usually means your firewall/antivirus is silently blocking Node.js from reaching the internet, or there's no internet connection. On Windows: Control Panel → Windows Defender Firewall → Allow an app through firewall → find 'Node.js' (or add it) → tick both Private and Public → OK, then restart `npm run dev`.",
      });
    }
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const EDGE_VOICE_MAP = {
  Hindi: "hi-IN-SwaraNeural",
  English: "en-IN-NeerjaNeural",
  Hinglish: "hi-IN-SwaraNeural",
  Assamese: "as-IN-YashicaNeural",
  Bengali: "bn-IN-TanishaaNeural",
  Tamil: "ta-IN-PallaviNeural",
  Spanish: "es-ES-ElviraNeural",
};

app.post("/api/tts", async (req, res) => {
  try {
    const { text, language } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: "No text provided" });
    const voice = EDGE_VOICE_MAP[language] || "en-US-JennyNeural";
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = await tts.toStream(text);
    res.setHeader("Content-Type", "audio/mpeg");
    audioStream.pipe(res);
    audioStream.on("error", (err) => {
      console.error("TTS stream error:", err);
      if (!res.headersSent) res.status(500).end();
    });
  } catch (err) {
    console.error("TTS error:", err);
    res.status(500).json({ error: err.message, note: "Falling back to browser voice on the frontend." });
  }
});

const WAV2LIP_SERVICE_URL = process.env.WAV2LIP_SERVICE_URL || "http://localhost:5005";

app.post("/api/avatar-video", async (req, res) => {
  try {
    const { text, language } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: "No text provided" });

    const voice = EDGE_VOICE_MAP[language] || "en-US-JennyNeural";
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = await tts.toStream(text);
    const chunks = [];
    for await (const chunk of audioStream) chunks.push(chunk);
    const audioBuffer = Buffer.concat(chunks);

    const form = new FormData();
    form.append("audio", new Blob([audioBuffer], { type: "audio/mpeg" }), "speech.mp3");

    const upstream = await fetch(`${WAV2LIP_SERVICE_URL}/lipsync`, {
      method: "POST",
      body: form,
    });

    if (!upstream.ok) {
      const errBody = await upstream.text();
      console.error("Wav2Lip service error:", errBody);
      return res.status(502).json({
        error: "Wav2Lip service didn't return a video. Is it running? See WAV2LIP_SETUP.md.",
        details: errBody,
      });
    }

    const videoBuffer = Buffer.from(await upstream.arrayBuffer());
    res.setHeader("Content-Type", "video/mp4");
    res.send(videoBuffer);
  } catch (err) {
    console.error("Avatar video error:", err);
    res.status(500).json({
      error: err.message,
      note: "Could not reach the Wav2Lip service at " + WAV2LIP_SERVICE_URL + ". See WAV2LIP_SETUP.md — make sure `python app.py` is running in wav2lip-service/.",
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`VidyaguruAI running at http://localhost:${PORT}`));
