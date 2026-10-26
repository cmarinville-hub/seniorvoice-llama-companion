const express = require("express");

const FormData = require("form-data");
const fs = require("fs");

const app = express();
app.use(express.json());

const LLAMA_API_KEY = process.env.LLAMA_API_KEY || "";
const LLAMA_API_URL = process.env.LLAMA_API_URL || "https://openrouter.ai/api/v1/chat/completions"; 
const LLAMA_MODEL = process.env.LLAMA_MODEL || "meta-llama/llama-3.3-70b-instruct:free";
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "meta_hackathon_token_2026";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "";
const HF_TOKEN = process.env.HF_TOKEN || "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";

app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
        return res.status(200).send(challenge);
    }
    return res.status(403).send("Token de verificación inválido.");
});

// Descarga el audio desde los servidores de Meta
async function descargarAudioMeta(mediaId, token) {
  const metaRes = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const metaData = await metaRes.json();
  if (!metaData.url) {
    throw new Error(`No se pudo obtener URL de descarga de Meta: ${JSON.stringify(metaData)}`);
  }

  const audioRes = await fetch(metaData.url, {
    headers: { 
      Authorization: `Bearer ${token}`,
      "User-Agent": "Mozilla/5.0"
    }
  });

  if (!audioRes.ok) {
    throw new Error(`Fallo descargando audio de Meta CDN: status ${audioRes.status}`);
  }

  const arrayBuffer = await audioRes.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// Transcribe el audio usando Whisper
async function transcribirConWhisper(audioBuffer, groqApiKey) {
  const form = new FormData();
  form.append("file", audioBuffer, {
    filename: "audio.ogg",
    contentType: "audio/ogg",
  });
  form.append("model", "whisper-large-v3");
  form.append("language", "es");

  const whisperRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${groqApiKey}`,
      ...form.getHeaders()
    },
    body: form.getBuffer() // <-- getBuffer() envía el binario completo de inmediato
  });

  const whisperData = await whisperRes.json();
  if (!whisperRes.ok) {
    throw new Error(`Fallo en Whisper: ${JSON.stringify(whisperData)}`);
  }
  return whisperData.text;
}


app.post("/webhook", async (req, res) => {
    res.status(200).send("EVENT_RECEIVED");

    try {
        const body = req.body;
        if (!body.entry || !body.entry[0]?.changes?.[0]?.value?.messages) {
            return;
        }

        const messageData = body.entry[0].changes[0].value.messages[0];
    const senderPhone = messageData.from;
    let userMessage = "";

    // 1. Mensaje de texto
    if (messageData.type === "text") {
      userMessage = messageData.text.body;
      console.log(`[ENTRANTE TEXTO]: "${userMessage}"`);
    } 
    // 2. Nota de voz / Audio real procesado por Whisper
    else if (messageData.type === "audio" || messageData.type === "voice") {
      console.log(`[ENTRANTE AUDIO]: ID ${messageData.audio.id}`);
      const audioBuffer = await descargarAudioMeta(messageData.audio.id, WHATSAPP_TOKEN);
      userMessage = await transcribirConWhisper(audioBuffer, LLAMA_API_KEY);
      console.log(`[WHISPER TRANSCRIPCIÓN]: "${userMessage}"`);
    }

    const userMessageText = userMessage;

        if (!userMessageText) return;

        console.log(`[ENTRANTE] De: ${senderPhone} | Mensaje: ${userMessageText}`);

const systemPrompt = `Eres SeniorVoice, un asistente empático y proactivo para adultos mayores. Tu objetivo es conversar de forma cariñosa, breve, clara y respetuosa, como un cuidador o familiar cercano. No uses apodos románticos de pareja y evita un tono cursi o melodramático.

REGLA DE IDIOMA (BILINGÜE / MULTILINGUAL):
- Detecta el idioma del usuario y responde SIEMPRE en ese mismo idioma (Español o Inglés).
- If the user speaks in English, maintain the exact same warm, respectful, and supportive personality.

1. FORMATO ESTRICTO DE AUDIO (TTS):
- PROHIBIDO EL USO DE EMOJIS (Neither in Spanish nor in English). Cero emojis.
- Usa signos de puntuación claros para pausas naturales.
- Respuestas breves: máximo 2 o 3 oraciones.

2. REGLA DE SERVICIOS Y ROL (SANDBOX):
- PROHIBIDO decir frases como "Soy una IA" o "I am an AI model".
- PROHIBIDO prometer que vas a gestionar, coordinar o despachar compras, medicamentos o citas.
- Si el usuario pide medicamentos, citas, transporte o ayuda física, tu ÚNICA respuesta debe ser sugerir amablemente que se comunique con su familia para que le ayuden.
  * En inglés: Kindly suggest they reach out to their family to help them coordinate it.

3. ESTIMULACIÓN COGNITIVA PROACTIVA ("GOLDEN GYM"):
- Si el usuario saluda casualmente, está aburrido o ya atendiste su inquietud, lanza un micro-reto mental nostálgico o refrán clásico.
  * Español: "A caballo regalado...", recuerdos de juventud.
  * Inglés: Proverbios clásicos como "An apple a day...", "A penny for your thoughts...", o recuerdos de su juventud.
- Debe sonar como una conversación amigable de café, nunca como un examen.`;
        

        const llamaResponse = await fetch(LLAMA_API_URL, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${LLAMA_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: LLAMA_MODEL,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userMessageText }
                ],
                temperature: 0.6,
                max_tokens: 150
            })
        });

        if (!llamaResponse.ok) {
            const errDetails = await llamaResponse.text();
            throw new Error(`Error en API Llama (${llamaResponse.status}): ${errDetails}`);
        }

        const data = await llamaResponse.json();
        const botReply = data.choices?.[0]?.message?.content || "Un gusto saludarte.";

console.log(`[RESPUESTA LLAMA]: ${botReply}`);

// ==========================================
    // 1. GENERAR AUDIO CON GOOGLE CLOUD TTS (BILINGÜE)
    // ==========================================
    // Detección rápida de idioma basada en palabras clave del inglés
    const isEnglish = /\b(the|is|you|and|are|hello|hi|good|morning|how|what|please|need|help|family|today|take|care)\b/i.test(botReply);

    const languageCode = isEnglish ? "en-US" : "es-US";
    const voiceName = isEnglish ? "en-US-Neural2-F" : "es-US-Neural2-A"; // Voces femeninas cálidas premium

    console.log(`[TTS]: Sintetizando voz en ${languageCode} (${voiceName})...`);

    const tokenRes = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
      headers: { "Metadata-Flavor": "Google" }
    });
    const { access_token } = await tokenRes.json();

    const ttsRes = await fetch("https://texttospeech.googleapis.com/v1/text:synthesize", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${access_token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        input: { text: botReply },
        voice: {
          languageCode: languageCode,
          name: voiceName,
          ssmlGender: "FEMALE"
        },
        audioConfig: {
          audioEncoding: "MP3"
        }
      })
    });

    if (!ttsRes.ok) {
      const errText = await ttsRes.text();
      throw new Error(`Fallo en Google Cloud TTS (${ttsRes.status}): ${errText}`);
    }

    const ttsData = await ttsRes.json();
    const audioBuffer = Buffer.from(ttsData.audioContent, "base64");
    console.log(`[TTS]: Audio generado con éxito (${audioBuffer.length} bytes) en ${languageCode}`);

// ==========================================
    // 2. SUBIR BINARIO A META GRAPH API (/media)
    // ==========================================
    console.log(`[META MEDIA]: Subiendo archivo de audio a Meta...`);

    const audioBlob = new Blob([audioBuffer], { type: "audio/mpeg" });
    const formData = new globalThis.FormData();
    formData.append("messaging_product", "whatsapp");
    formData.append("type", "audio/mpeg");
    formData.append("file", audioBlob, "respuesta.mp3");

    const mediaRes = await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/media`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.WHATSAPP_TOKEN || WHATSAPP_TOKEN}`
      },
      body: formData
    });

    const mediaData = await mediaRes.json();
    if (!mediaData.id) {
      throw new Error(`Error al subir audio a Meta: ${JSON.stringify(mediaData)}`);
    }
    console.log(`[META MEDIA ID]: ${mediaData.id}`);

    // ==========================================
    // 3. ENVIAR NOTA DE VOZ A WHATSAPP
    // ==========================================
    const envioRes = await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.WHATSAPP_TOKEN || WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: senderPhone,
        type: "audio",
        audio: { id: mediaData.id }
      })
    });

    const envioData = await envioRes.json();
    console.log(`[WHATSAPP AUDIO ENVIADO]:`, JSON.stringify(envioData));

  } catch (error) {
    console.error("[ERROR SANDBOX]:", error.message);
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Sandbox de Llama activo en el puerto ${PORT}`);
});