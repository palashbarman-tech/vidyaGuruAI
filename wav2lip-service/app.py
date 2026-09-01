import os
import subprocess
import tempfile
from flask import Flask, request, send_file, jsonify

app = Flask(__name__)

WAV2LIP_DIR = os.environ.get("WAV2LIP_DIR", os.path.expanduser("~/Wav2Lip"))
CHECKPOINT_PATH = os.environ.get(
    "WAV2LIP_CHECKPOINT",
    os.path.join(WAV2LIP_DIR, "checkpoints", "wav2lip_gan.pth"),
)
FACE_IMAGE = os.environ.get(
    "AVATAR_FACE_PATH",
    os.path.join(os.path.dirname(__file__), "avatar.jpg"),
)

@app.route("/health", methods=["GET"])
def health():
    ok = os.path.exists(WAV2LIP_DIR) and os.path.exists(CHECKPOINT_PATH) and os.path.exists(FACE_IMAGE)
    return jsonify({
        "ready": ok,
        "wav2lip_dir_exists": os.path.exists(WAV2LIP_DIR),
        "checkpoint_exists": os.path.exists(CHECKPOINT_PATH),
        "face_image_exists": os.path.exists(FACE_IMAGE),
    })

@app.route("/lipsync", methods=["POST"])
def lipsync():
    if "audio" not in request.files:
        return jsonify({"error": "no audio file uploaded (expected multipart field 'audio')"}), 400
    if not os.path.exists(WAV2LIP_DIR):
        return jsonify({"error": f"WAV2LIP_DIR not found at {WAV2LIP_DIR}. See WAV2LIP_SETUP.md."}), 500
    if not os.path.exists(CHECKPOINT_PATH):
        return jsonify({"error": f"Checkpoint not found at {CHECKPOINT_PATH}. Download wav2lip_gan.pth — see WAV2LIP_SETUP.md."}), 500
    if not os.path.exists(FACE_IMAGE):
        return jsonify({"error": f"Avatar face image not found at {FACE_IMAGE}. Add your own photo there — see WAV2LIP_SETUP.md."}), 500

    audio_file = request.files["audio"]

    with tempfile.TemporaryDirectory() as tmp:
        audio_path = os.path.join(tmp, "input_audio.mp3")
        audio_file.save(audio_path)
        output_path = os.path.join(tmp, "output.mp4")

        cmd = [
            "python", os.path.join(WAV2LIP_DIR, "inference.py"),
            "--checkpoint_path", CHECKPOINT_PATH,
            "--face", FACE_IMAGE,
            "--audio", audio_path,
            "--outfile", output_path,
        ]

        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, cwd=WAV2LIP_DIR, timeout=300
            )
        except subprocess.TimeoutExpired:
            return jsonify({"error": "Wav2Lip timed out (over 5 minutes). Try a shorter sentence or a GPU machine."}), 500

        if result.returncode != 0 or not os.path.exists(output_path):
            return jsonify({
                "error": "Wav2Lip failed",
                "details": (result.stderr or "")[-3000:],
            }), 500

        return send_file(output_path, mimetype="video/mp4", as_attachment=False)

if __name__ == "__main__":
    print(f"Wav2Lip service starting. WAV2LIP_DIR={WAV2LIP_DIR}")
    print(f"Checkpoint: {CHECKPOINT_PATH}")
    print(f"Face image: {FACE_IMAGE}")
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5005)))
