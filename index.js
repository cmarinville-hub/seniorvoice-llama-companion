const express = require('express');
const fetch = require('node-fetch');
const FormData = require('form-data');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
 
const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
 
// CONFIGURACION (todo por variables de entorno)
const PORT = process.env.PORT || 8080;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const DEFAULT_PHONE_ID = process.env.PHONE_NUMBER_ID;
const META_APP_SECRET = process.env.META_APP_SECRET; // opcional: valida la firma del webhook
const META_MODEL_API_KEY = process.env.META_MODEL_API_KEY;
const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://api.meta.ai/v1';
const LLM_MODEL = process.env.LLM_MODEL || 'muse-spark-1.2';
const STT_URL = process.env.STT_URL || 'https://api.meta.ai/v1/asr/transcribe';
const STT_MODEL = process.env.STT_MODEL || 'muse-voice-transcribe-1.0';
const HTTP_TIMEOUT_MS = 20000;
const TTS_URL = process.env.TTS_URL; // servicio MMS-TTS de Meta (Cloud Run)
const TTS_API_KEY = process.env.TTS_API_KEY || '';
const MAX_HISTORY_TURNS = 6;
 
// 1. Verificacion del webhook de WhatsApp
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
 
// 2. Prompt del sistema
const SYSTEM_PROMPT = `Eres SeniorVoice, un asistente por voz que ofrece compañía y ejercicios mentales a adultos mayores en Costa Rica y Latinoamérica.
- Habla siempre de forma cálida, paciente, respetuosa y concisa (máximo 2 a 3 oraciones por respuesta).
- Si el usuario te pregunta si eres una persona real o quién eres, responde con honestidad y calidez: "Soy la asistente virtual de SeniorVoice, para servirle".
- PROHIBIDO usar clichés robóticos de descargo ("Como modelo de lenguaje...", "No tengo cuerpo físico").
- Tu única función es conversar para hacer compañía y proponer ejercicios mentales: trivias de cultura general, adivinanzas, preguntas y respuestas, y recuerdos agradables.
- Si el usuario pide algo fuera de esa función, responde con amabilidad que solo puedes conversar y proponer ejercicios mentales, y sugiere que consulte a su familia o a un profesional. No des consejos médicos ni prometas gestionar nada.
- Adapta tu idioma automáticamente (si te hablan en inglés, responde en inglés; si es en español, responde en español).
- Si el usuario manifiesta aburrimiento o desánimo, propón un ejercicio mental ligero o una conversación sobre un recuerdo agradable.`;
 
// Utilidades: deduplicacion de mensajes e historial por numero
const procesados = new Map(); // message.id -> timestamp
const historial = new Map(); // numero -> [{role, content}]
 
function yaProcesado(id) {
    const ahora = Date.now();
    for (const [k, t] of procesados) {
        if (ahora - t > 10 * 60 * 1000) procesados.delete(k);
    }
    if (procesados.has(id)) return true;
    procesados.set(id, ahora);
    return false;
}
 
function guardarTurno(numero, role, content) {
    const h = historial.get(numero) || [];
    h.push({ role, content });
    while (h.length > MAX_HISTORY_TURNS * 2) h.shift();
    historial.set(numero, h);
}
 
function firmaValida(req) {
    if (!META_APP_SECRET) return true; // sin secreto configurado no se valida
    const recibida = req.get('x-hub-signature-256') || '';
    const esperada = 'sha256=' + crypto.createHmac('sha256', META_APP_SECRET).update(req.rawBody || '').digest('hex');
    const a = Buffer.from(recibida);
    const b = Buffer.from(esperada);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}
 
// 3. Razonamiento con Llama / Muse (Meta Model API, protocolo OpenAI)
// Devuelve { ok: true, texto } o { ok: false }
async function consultarModelo(numero, textoUsuario) {
    try {
        const mensajes = [
            { role: 'system', content: SYSTEM_PROMPT },
            ...(historial.get(numero) || []),
            { role: 'user', content: textoUsuario }
        ];
        const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
            method: 'POST',
            timeout: HTTP_TIMEOUT_MS,
            headers: {
                'Authorization': `Bearer ${META_MODEL_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: LLM_MODEL,
                messages: mensajes,
                temperature: 0.6,
                max_tokens: 2000
            })
        });
        const data = await response.json();
        if (!response.ok) {
            console.error('[LLM ERROR]:', response.status, JSON.stringify(data));
            return { ok: false };
        }
        const texto = data.choices?.[0]?.message?.content;
        if (!texto) {
            console.error('[LLM ERROR] Respuesta sin contenido:', JSON.stringify(data));
            return { ok: false };
        }
        guardarTurno(numero, 'user', textoUsuario);
        guardarTurno(numero, 'assistant', texto);
        return { ok: true, texto };
    } catch (err) {
        console.error('[LLM EXCEPCION]:', err.message);
        return { ok: false };
    }
}
 
// 4. Transcripcion de audio (Muse Voice Transcribe de Meta)
function convertirAWav(bufferEntrada) {
    return new Promise((resolve, reject) => {
        const base = path.join(os.tmpdir(), `audio-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        const entrada = `${base}.in`;
        const salida = `${base}.wav`;
        fs.writeFileSync(entrada, bufferEntrada);
        execFile(ffmpegPath, ['-y', '-i', entrada, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', salida], { timeout: 30000 }, (err, stdout, stderr) => {
            try {
                if (err) {
                    return reject(new Error(`ffmpeg fallo: ${(stderr || err.message).slice(-300)}`));
                }
                resolve(fs.readFileSync(salida));
            } finally {
                fs.rm(entrada, () => {});
                fs.rm(salida, () => {});
            }
        });
    });
}
 
async function transcribirAudio(audioId) {
    try {
        console.log(`[STT 1] Obteniendo URL de descarga para audio ID: ${audioId}`);
        const metaMediaRes = await fetch(`https://graph.facebook.com/v21.0/${audioId}`, {
            timeout: HTTP_TIMEOUT_MS,
            headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
        });
        const mediaData = await metaMediaRes.json();
        if (!metaMediaRes.ok || !mediaData.url) {
            console.error('[STT ERROR URL]:', JSON.stringify(mediaData));
            return '';
        }
 
        console.log('[STT 2] Descargando audio desde Meta CDN');
        const audioBlobRes = await fetch(mediaData.url, {
            timeout: HTTP_TIMEOUT_MS,
            headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
        });
        if (!audioBlobRes.ok) {
            console.error(`[STT ERROR DESCARGA]: HTTP ${audioBlobRes.status}`);
            return '';
        }
        const audioOriginal = await audioBlobRes.buffer();
        console.log(`[STT 3] Audio descargado (${audioOriginal.length} bytes). Convirtiendo a WAV`);
 
        const wav = await convertirAWav(audioOriginal);
 
        const form = new FormData();
        form.append('request', JSON.stringify({ mode: 'ENDPOINTING', model: STT_MODEL, audioEncoding: 'WAV' }), { contentType: 'application/json' });
        form.append('audio', wav, { filename: 'audio.wav', contentType: 'audio/wav' });
 
        const sttRes = await fetch(STT_URL, {
            method: 'POST',
            timeout: HTTP_TIMEOUT_MS,
            headers: {
                'Authorization': `Bearer ${META_MODEL_API_KEY}`,
                'Accept': 'application/json',
                ...form.getHeaders()
            },
            body: form
        });
        const sttData = await sttRes.json();
        if (!sttRes.ok) {
            console.error('[STT ERROR]:', sttRes.status, JSON.stringify(sttData));
            return '';
        }
        console.log('[STT 4] Transcripcion recibida');
        return sttData.transcript || '';
    } catch (err) {
        console.error('[STT EXCEPCION]:', err.message);
        return '';
    }
}
 
// 5. Envio de respuesta a WhatsApp
async function enviarWhatsApp(phoneNumberId, fromNumber, textoRespuesta) {
    const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;
    try {
        const res = await fetch(url, {
            method: 'POST',
            timeout: HTTP_TIMEOUT_MS,
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
        const resJson = await res.json();
        if (!res.ok) {
            console.error('[WHATSAPP SEND ERROR]:', JSON.stringify(resJson));
        } else {
            console.log(`[WHATSAPP OK] Mensaje enviado a ${fromNumber}`);
        }
    } catch (err) {
        console.error('[WHATSAPP EXCEPCION]:', err.message);
    }
}
 
// 6. Procesamiento del webhook POST
// 5b. Respuesta por voz (MMS-TTS de Meta alojado en Cloud Run)
function wavAOgg(bufferWav) {
    return new Promise((resolve, reject) => {
        const base = path.join(os.tmpdir(), `voz-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        const entrada = `${base}.wav`;
        const salida = `${base}.ogg`;
        fs.writeFileSync(entrada, bufferWav);
        execFile(ffmpegPath, ['-y', '-i', entrada, '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '24k', '-application', 'voip', salida], { timeout: 30000 }, (err, stdout, stderr) => {
            try {
                if (err) {
                    return reject(new Error(`ffmpeg opus fallo: ${(stderr || err.message).slice(-300)}`));
                }
                resolve(fs.readFileSync(salida));
            } finally {
                fs.rm(entrada, () => {});
                fs.rm(salida, () => {});
            }
        });
    });
}

async function responderConVoz(phoneNumberId, to, texto) {
    try {
        const ttsRes = await fetch(`${TTS_URL}/synthesize`, {
            method: 'POST',
            timeout: 60000,
            headers: { 'Content-Type': 'application/json', 'x-api-key': TTS_API_KEY },
            body: JSON.stringify({ text: texto, lang: /[áéíóúüñ¿¡]|\b(que|una|los|las|para|con|está|son|yo|hola|bien)\b/i.test(texto) ? 'es' : 'en' })
        });
        if (!ttsRes.ok) {
            console.error('[TTS ERROR]:', ttsRes.status, (await ttsRes.text()).slice(0, 200));
            return false;
        }
        const wav = await ttsRes.buffer();
        const ogg = await wavAOgg(wav);

        const form = new FormData();
        form.append('messaging_product', 'whatsapp');
        form.append('type', 'audio/ogg');
        form.append('file', ogg, { filename: 'respuesta.ogg', contentType: 'audio/ogg' });
        const upRes = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/media`, {
            method: 'POST',
            timeout: HTTP_TIMEOUT_MS,
            headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, ...form.getHeaders() },
            body: form
        });
        const upJson = await upRes.json();
        if (!upRes.ok || !upJson.id) {
            console.error('[TTS MEDIA ERROR]:', JSON.stringify(upJson));
            return false;
        }

        const sendRes = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
            method: 'POST',
            timeout: HTTP_TIMEOUT_MS,
            headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'audio', audio: { id: upJson.id } })
        });
        const sendJson = await sendRes.json();
        if (!sendRes.ok) {
            console.error('[TTS SEND ERROR]:', JSON.stringify(sendJson));
            return false;
        }
        console.log(`[WHATSAPP OK] Nota de voz enviada a ${to}`);
        return true;
    } catch (err) {
        console.error('[TTS EXCEPCION]:', err.message);
        return false;
    }
}

app.post('/webhook', async (req, res) => {
    const body = req.body;
 
    if (!firmaValida(req)) {
        console.warn('[WEBHOOK] Firma invalida, solicitud rechazada.');
        return res.sendStatus(401);
    }
 
    if (!body || !body.object) {
        return res.sendStatus(404);
    }
 
    try {
        const value = body.entry?.[0]?.changes?.[0]?.value;
        const phoneNumberId = value?.metadata?.phone_number_id || DEFAULT_PHONE_ID;
        const message = value?.messages?.[0];
 
        if (!message || yaProcesado(message.id)) {
            return res.status(200).send('EVENT_RECEIVED');
        }
 
        const from = message.from;
        let textoEntrada = '';
 
        if (message.type === 'text') {
            textoEntrada = message.text?.body || '';
        } else if (message.type === 'audio') {
            console.log(`[STT] Procesando nota de voz de ${from}`);
            textoEntrada = await transcribirAudio(message.audio.id);
            if (!textoEntrada.trim()) {
                console.warn(`[STT AVISO] No se pudo transcribir el audio de ${from}`);
                await enviarWhatsApp(phoneNumberId, from, 'Disculpe, no pude escuchar bien su nota de voz. ¿Podría repetirla o escribirme por aquí?');
                return res.status(200).send('EVENT_RECEIVED');
            }
        } else {
            return res.status(200).send('EVENT_RECEIVED');
        }
 
        if (textoEntrada.trim().length > 0) {
            console.log(`[ENTRADA] ${from}: ${textoEntrada}`);
            const r = await consultarModelo(from, textoEntrada);
            const respuesta = r.ok ? r.texto : 'Disculpe, tuve un problema técnico. ¿Podría intentarlo de nuevo en un momento?';
            console.log(`[SALIDA]: ${respuesta}`);
            let enviadoComoVoz = false;
            if (message.type === 'audio' && r.ok && TTS_URL) {
                enviadoComoVoz = await responderConVoz(phoneNumberId, from, respuesta);
            }
            if (!enviadoComoVoz) {
                await enviarWhatsApp(phoneNumberId, from, respuesta);
            }
        }
    } catch (error) {
        console.error('[PROCESO ERROR]:', error.message || error);
    }
 
    return res.status(200).send('EVENT_RECEIVED');
});
 
app.listen(PORT, () => {
    console.log(`SeniorVoice activo en el puerto ${PORT} (modelo: ${LLM_MODEL})`);
});
 
