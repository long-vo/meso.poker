FROM denoland/deno:alpine-2.9.2

WORKDIR /app

# Copy config first for better layer caching
COPY deno.json ./
COPY main.ts ./
COPY src/ ./src/
COPY static/ ./static/

# Pre-compile / cache dependencies
RUN deno cache main.ts

# Render sets PORT; default matches local dev
ENV PORT=8000
EXPOSE 8000

USER deno

CMD ["run", "--allow-net", "--allow-read", "--allow-env", "main.ts"]
