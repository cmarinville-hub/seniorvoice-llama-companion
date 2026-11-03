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

## Architecture

```
WhatsApp voice note (OGG/Opus)
↓ WhatsApp Cloud API webhook
index.js on Cloud Run (Node.js, Express)
↓ ffmpeg: OGG/Opus to 16 kHz mono WAV
Muse Voice Transcribe (Meta Model API): audio to text
↓
Muse Spark 1.2 (Meta Model API): reply text
↓
tts-service (FastAPI + MMS-TTS): text to WAV
↓ ffmpeg: WAV to OGG/Opus
WhatsApp voice note back to the user
```

Two deployable units: the Node.js webhook (`index.js`) and the Python TTS service (`tts-service/`). They share a secret through the `x-api-key` header (`TTS_API_KEY`).

## Design decisions

**Voice in, voice out.** A voice note gets a voice note back. A text message gets a text reply.

**Graceful degradation.** If transcription fails, the user gets a kind request to repeat. If the model fails, the user gets an apology message. If voice synthesis fails, the reply is sent as text.

**Webhook hardening.** The `X-Hub-Signature-256` header is validated with HMAC-SHA256 and a timing-safe comparison when `META_APP_SECRET` is set. Incoming message IDs are deduplicated for 10 minutes, so WhatsApp retries do not produce duplicate replies.

**Bounded calls.** External HTTP calls time out at 20 s (60 s for synthesis) and ffmpeg runs time out at 30 s.

**Audio pipeline.** Input is converted to 16 kHz mono PCM WAV for transcription. Output is encoded as Opus at 24 kbps (voip profile), which WhatsApp plays as a voice note.

**Prompt design.** Replies are limited to 2-3 short sentences, warm and patient in tone. The assistant answers honestly that it is a virtual assistant and stays within companionship and mental exercises.

**Context.** The last 6 turns per user are sent with each request.

## Testing the services

```bash
# Webhook verification handshake (expects the challenge back)
curl "http://localhost:8080/webhook?hub.mode=subscribe&hub.verify_token=$WHATSAPP_VERIFY_TOKEN&hub.challenge=123"

# TTS service health and synthesis
curl $TTS_URL/health
curl -X POST $TTS_URL/synthesize -H "Content-Type: application/json" -H "x-api-key: $TTS_API_KEY" -d '{"text":"Hola, ¿cómo amaneció hoy?"}' --output respuesta.wav
```

## Known limitations

**Voice synthesis is Spanish only.** `tts-service/` loads `facebook/mms-tts-spa`. The webhook sends a `lang` hint (es/en), but the service does not use it yet, so an English reply would be voiced by the Spanish model and be hard to understand. Next step: load `facebook/mms-tts-eng` and select the model by `lang`.

**Conversation history lives in memory.** It is lost on restart and is not shared across Cloud Run instances. Next step: move it to a persistent store.

**Synthesis input is capped at 600 characters** per reply.

**Webhook signature validation is optional.** Set `META_APP_SECRET` in any production deployment.

**Not a medical or emergency tool.** The assistant gives no medical advice and does not contact anyone on the user's behalf.
