# SeniorVoice - Llama 3.1 Voice Concierge for the Elderly

A voice-first WhatsApp companion powered by **Meta Llama 3.1**, Whisper STT, and Google Cloud Run. SeniorVoice eliminates screen friction for elderly users, providing daily cognitive stimulation (*Golden Gym*), empathetic conversation, and logistics coordination without autonomous real-world risks.

## Tech Stack
- **Conversational Engine:** Meta Llama 3.1 (70B)
- **STT:** Whisper Large v3
- **Channels:** WhatsApp Cloud API (Meta Graph API v21.0)
- **Backend:** Node.js Express on Google Cloud Run (Serverless)

## Architecture & Lifecycle
The webhook delays the HTTP 200 event acknowledgment until outbound audio/text synthesis is completed, preventing container CPU throttling during asynchronous tasks.

## Environment Configuration
```bash
WHATSAPP_TOKEN="<META_SYSTEM_USER_TOKEN>"
WHATSAPP_VERIFY_TOKEN="<WEBHOOK_SECRET>"
META_MODEL_API_KEY="<META_MODEL_API_KEY>"
GROQ_API_KEY="<GROQ_WHISPER_KEY>"
