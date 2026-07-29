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

# Room stats keep a Deno KV database. /tmp is writable whichever uid the
# container runs as, which lets --allow-write below stay scoped to it. The file
# is as ephemeral as the container: on Render's free plan (no persistent disk,
# spins down when idle) stats reach back only to the last cold start. Deno
# Deploy ignores this and uses its managed, cross-isolate KV instead.
ENV POKER_KV_PATH=/tmp/meso-poker-kv.sqlite3

USER deno

CMD ["run", "--unstable-kv", "--allow-net", "--allow-read", "--allow-write=/tmp", \
  "--allow-env", "main.ts"]
