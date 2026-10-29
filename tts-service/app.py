import io
import os
import torch
import scipy.io.wavfile as wavfile
from fastapi import FastAPI, Header, HTTPException, Response
from pydantic import BaseModel
from transformers import VitsModel, AutoTokenizer

MODEL_ID = "facebook/mms-tts-spa"
model = VitsModel.from_pretrained(MODEL_ID).eval()
tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
API_KEY = os.environ.get("TTS_API_KEY", "")

app = FastAPI()


class Req(BaseModel):
    text: str


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_ID}


@app.post("/synthesize")
def synthesize(req: Req, x_api_key: str = Header(default="")):
    if API_KEY and x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="unauthorized")
    text = req.text.strip()[:600]
    if not text:
        raise HTTPException(status_code=400, detail="empty text")
    inputs = tokenizer(text, return_tensors="pt")
    torch.manual_seed(0)
    with torch.no_grad():
        wave = model(**inputs).waveform
    audio = wave.squeeze().cpu().numpy()
    buf = io.BytesIO()
    wavfile.write(buf, model.config.sampling_rate, audio)
    return Response(content=buf.getvalue(), media_type="audio/wav")
