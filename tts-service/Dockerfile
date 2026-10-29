FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
RUN python -c "from transformers import VitsModel, AutoTokenizer; VitsModel.from_pretrained('facebook/mms-tts-spa'); AutoTokenizer.from_pretrained('facebook/mms-tts-spa')"
ENV PORT=8080
CMD exec uvicorn app:app --host 0.0.0.0 --port ${PORT}
