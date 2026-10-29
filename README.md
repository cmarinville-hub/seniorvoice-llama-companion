# SeniorVoice - voice companion and mental exercises for older adults

SeniorVoice is a voice-first WhatsApp assistant for older adults. The user sends a voice note, and the
assistant answers with a short voice note. It does two things only: friendly conversation, and light mental
exercises (trivia, riddles, questions and answers, pleasant memories). It gives no medical advice and does not
manage tasks or services on behalf of the user.

This repository is the hackathon sandbox. Its first commit is from Oct 26, 2026.

## How it works

1. The user sends a WhatsApp voice note (OGG/Opus).
2. The webhook downloads the audio from the WhatsApp Cloud API and converts it to 16 kHz mono WAV with ffmpeg.
3. **Muse Voice Transcribe** (Meta Model API) transcribes it.
4. **Muse Spark** (Meta Model API, `muse-spark-1.2`) writes a short, warm reply following the system prompt.
5. **MMS-TTS** (`facebook/mms-tts-spa`, Meta open weights, self-hosted in `tts-service/`) turns the reply into speech.
6. The audio is converted to OGG/Opus and sent back as a WhatsApp voice note. If voice synthesis fails, the reply is sent as text.

Short per-user conversation history is kept in memory so replies stay in context.

## Meta technology used

| Step | Model or API |
|---|---|
| Speech to text | Muse Voice Transcribe, Meta Model API |
| Conversation and exercises | Muse Spark 1.2, Meta Model API |
| Text to speech | MMS-TTS (Spanish), Meta open weights, self-hosted |
| Messaging channel | WhatsApp Cloud API (Meta Graph API v21.0) |

No non-Meta AI model is used.

## Repository layout

- `index.js`: Express webhook, orchestration, WhatsApp messaging.
- `tts-service/`: FastAPI service that serves MMS-TTS.

## Configuration

Set these as environment variables (never commit them):

```bash
WHATSAPP_TOKEN="<whatsapp access token>"
WHATSAPP_VERIFY_TOKEN="<webhook verify token>"
PHONE_NUMBER_ID="<whatsapp phone number id>"
META_MODEL_API_KEY="<meta model api key>"
TTS_URL="<url of the tts-service>"
TTS_API_KEY="<shared secret between the two services>"
# optional
META_APP_SECRET="<validates the webhook signature>"
LLM_BASE_URL="https://api.meta.ai/v1"
LLM_MODEL="muse-spark-1.2"
STT_URL="https://api.meta.ai/v1/asr/transcribe"
STT_MODEL="muse-voice-transcribe-1.0"
```

## Run and deploy

```bash
npm install
npm start                      # listens on PORT (default 8080)

# Cloud Run
gcloud run deploy seniorvoice-llama --source . --region us-central1 --allow-unauthenticated
gcloud run deploy seniorvoice-tts --source tts-service --region us-central1 --memory 4Gi --cpu 2
```

Point the WhatsApp webhook to `https://<service-url>/webhook`.

## Scope and safety

- Conversation and mental exercises only.
- No medical advice, and no management of tasks or services.
- When asked for anything else, the assistant says so kindly and suggests asking family or a professional.
