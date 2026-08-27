# syntax=docker/dockerfile:1
FROM python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1

# PyMuPDF and Pillow ship wheels for this platform; no build toolchain needed.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . ./

RUN useradd --create-home --uid 10001 app && mkdir -p /data/blobs && chown -R app /data/blobs
USER app

CMD ["python", "worker.py"]
