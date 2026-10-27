const express = require('express');
const fetch = require('node-fetch');
const FormData = require('form-data');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const META_MODEL_API_KEY = process.env.META_MODEL_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// 1. Verificación del Webhook de WhatsApp
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
        console.log('[WEBHOOK] Verificado exitosamente con Meta.');
        return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
});

// 2. Prompt del Sistema con Transparencia Ética y Concierge
const SYSTEM_PROMPT = `Eres SeniorVoice, un asistente y concierge empático por voz diseñado para adultos mayores en Costa Rica y Latinoamérica.
- Habla siempre de forma cálida, paciente, respetuosa y concisa (máximo 2 a 3 oraciones por respuesta).
- Si el usuario te pregunta directamente si eres una persona real o quién eres, responde con honestidad y calidez: "Soy la asistente virtual de SeniorVoice, Don Carlos; yo le acompaño por voz y tomo nota de todo para que el equipo humano se encargue de apoyarle."
- PROHIBIDO usar clichés robóticos de descargo ("Como modelo de lenguaje...", "No tengo cuerpo físico").
- Si el usuario solicita medicamentos, transporte o citas, confirma amablemente que ya tomaste nota para coordinarlo con su red familiar o de soporte.
- Adapta tu idioma automáticamente (si te hablan en inglés, responde en inglés; si es en español, responde en español).
- Activa el módulo "Golden Gym" si el usuario manifiesta aburrimiento o desánimo, proponiendo una trivia cultural o un recuerdo agradable.`;

// 3. Razonamiento con Llama 3.1
async function consultarLlama(textoUsuario) {
    const endpoint = 'https://api.groq.com/openai/v1/chat/completions';
    const apiKey = GROQ_API_KEY || META_MODEL_API_KEY;

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'llama-3.1-70b-versatile',
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: textoUsuario }
            ],
            temperature: 0.6,
            max_tokens: 250
        })
    });

    const data = await response.json();
    return data.choices?.[0]?.message?.content || "Disculpe Don Carlos, no le escuché bien. ¿Podría repetirme?";
}

// 4. Transcripción de Audio STT (Whisper vía Groq API)
async function transcribirAudio(audioId) {
    const metaMediaRes = await fetch(`https://graph.facebook.com/v21.0/${audioId}`, {
        headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
    });
    const mediaData = await metaMediaRes.json();
    
    const audioBlobRes = await fetch(mediaData.url, {
        headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
    });
    const audioBuffer = await audioBlobRes.buffer();

    const form = new FormData();
    form.append('file', audioBuffer, { filename: 'audio.ogg', contentType: 'audio/ogg' });
    form.append('model', 'whisper-large-v3');

    const whisperRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${GROQ_API_KEY}`,
            ...form.getHeaders()
        },
        body: form
    });

    const whisperData = await whisperRes.json();
    return whisperData.text || '';
}

// 5. Envío de Respuesta a WhatsApp
async function enviarWhatsApp(fromNumber, textoRespuesta) {
    await fetch(`https://graph.facebook.com/v21.0/me/messages`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: fromNumber,
            type: 'text',
            text: { body: textoRespuesta }
        })
    });
}

// 6. Procesamiento Webhook POST (Retardo del 200 hasta finalizar el envío para mantener CPU activa)
app.post('/webhook', async (req, res) => {
    const body = req.body;

    if (body.object) {
        try {
            const entry = body.entry?.[0];
            const changes = entry?.changes?.[0];
            const message = changes?.value?.messages?.[0];

            if (message) {
                const from = message.from;
                let textoEntrada = '';

                if (message.type === 'text') {
                    textoEntrada = message.text.body;
                } else if (message.type === 'audio') {
                    console.log(`[STT] Procesando nota de voz de ${from}...`);
                    textoEntrada = await transcribirAudio(message.audio.id);
                }

                if (textoEntrada) {
                    console.log(`[ENTRADA] ${from}: ${textoEntrada}`);
                    
                    const respuestaLlama = await consultarLlama(textoEntrada);
                    console.log(`[LLAMA 3.1]: ${respuestaLlama}`);

                    await enviarWhatsApp(from, respuestaLlama);
                    console.log(`[WHATSAPP] Respuesta enviada a ${from}`);
                }
            }

            return res.status(200).send('EVENT_RECEIVED');

        } catch (error) {
            console.error('[PROCESO ERROR]:', error);
            return res.status(200).send('EVENT_RECEIVED');
        }
    }

    res.sendStatus(404);
});

app.listen(PORT, () => {
    console.log(`SeniorVoice Llama 3.1 activo en el puerto ${PORT}`);
});