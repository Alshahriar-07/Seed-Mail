# Seed Code Mail — send worker image.
#
# Why this exists: a campaign is a long, sequential job holding an SMTP
# credential, which a Vercel serverless function cannot be. The worker has to run
# somewhere that keeps a process alive (Render, Railway, Fly.io, a small VM,
# Kubernetes) and this image is that process. The frontend never talks to it
# except over HTTPS with the user's Supabase token.
#
# Build from the REPOSITORY ROOT, not from worker/, so the shared `services/`
# package and the root `requirements.txt` are inside the build context:
#
#   docker build -f worker/Dockerfile -t seed-mail-worker .
#
# Run it with the worker's own environment (see README §3.3). Secrets are supplied
# at run time; none are baked into the image, and .env is excluded by
# .dockerignore:
#
#   docker run --rm -p 8765:8765 --env-file .env seed-mail-worker
#
# Docker is NOT required for local development — `python worker/main.py` is the
# documented local start (README §2) and needs no container.
FROM python:3.12-slim

# PYTHONUNBUFFERED keeps the startup diagnostics in the platform's log stream
# instead of a buffer that is only flushed on exit. PYTHONIOENCODING and
# errors="replace" (worker.config.configure_console_encoding) together make an
# unencodable character in a log line impossible to crash the worker — the
# failure mode that used to look like an unreachable worker.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONIOENCODING=utf-8 \
    PIP_NO_CACHE_DIR=1 \
    WORKER_HOST=0.0.0.0 \
    WORKER_PORT=8765

WORKDIR /app

# Dependencies first: this layer is cached and only rebuilt when requirements
# change, so ordinary deploys are quick.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Only what the worker actually imports. `services/` is shared with the local
# app and the tests, and the worker is its second consumer.
COPY worker/ ./worker/
COPY services/ ./services/

# The queue consumer is a background thread inside this process, so there is no
# second service to deploy.
RUN useradd --create-home --uid 10001 worker && chown -R worker:worker /app
USER worker

# A hosted container is unreachable unless it binds every interface; the default
# (127.0.0.1, correct for local runs) is overridden above.
EXPOSE 8765

# Probe the same unauthenticated endpoint the frontend uses. It reports honest
# configuration gaps (`configuration_problems`) rather than a fabricated "online",
# so a green healthcheck here means the process is alive — not that campaigns are
# configured. Check the JSON body before trusting a deployment.
HEALTHCHECK --interval=30s --timeout=6s --start-period=20s --retries=3 \
    CMD python -c "import os, sys, urllib.request; \
port = os.getenv('WORKER_PORT', '8765'); \
sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:' + port + '/api/worker/health', timeout=5).status == 200 else 1)"

# `python -m worker.main` (not `python worker/main.py`) on purpose: it keeps the
# repository root — not worker/ — on sys.path, so a module in worker/ can never
# shadow a standard-library module for the process. See worker/config.py and
# README §11d: the previous layout shadowed `queue` and made every endpoint 500.
CMD ["python", "-m", "worker.main"]
