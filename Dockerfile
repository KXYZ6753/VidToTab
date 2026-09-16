# VidToTab as a hosted web app.
#
# The desktop build is still the primary one; this is the same server.js behind
# a container, with the two things a hosted instance has to opt into set here:
# HOST=0.0.0.0 (the default is loopback, deliberately) and a writable /data.
# VIDTOTAB_PUBLIC is *not* set — whoever runs this decides whether the instance
# is public and therefore limited. An internal instance for one team is not.
#
# Node 26 rather than the 24 line: the app is developed and CI-tested on 26, and
# running the container on an older runtime than everything else is tested on is
# how a difference goes unnoticed until it is in production.

# --------------------------------------------------------------- dependencies
FROM node:26-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# electron and electron-builder are devDependencies worth several hundred MB,
# and the server loads neither. pdf-lib is the only thing it actually needs.
RUN npm ci --omit=dev

# --------------------------------------------------------------------- ffmpeg
# The same script the desktop build uses, so the container gets the same
# checksum-pinned LGPL build rather than whatever apt happens to be carrying —
# and a tampered or swapped upload fails the image build instead of shipping.
# It picks the target from the platform it runs on, so this works on an arm64
# builder as well; both Linux builds are pinned.
FROM node:26-bookworm-slim AS ffmpeg
WORKDIR /app
# GNU tar needs the xz binary to open the pinned .tar.xz, and slim has neither
# it nor a CA bundle. Both are thrown away with this stage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates xz-utils \
 && rm -rf /var/lib/apt/lists/*
COPY scripts/fetch-binaries.mjs ./scripts/
RUN node scripts/fetch-binaries.mjs \
 && mkdir -p /res/bin \
 && cp build/bin/*/* /res/bin/ \
 && /res/bin/ffmpeg -version | head -1

# ----------------------------------------------------------------------- app
FROM node:26-bookworm-slim
ENV NODE_ENV=production \
    VIDTOTAB_MODE=web \
    VIDTOTAB_DATA_DIR=/data \
    VIDTOTAB_RESOURCES_DIR=/app/res \
    HOST=0.0.0.0 \
    PORT=3000

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# pipeline/tools.js looks in <VIDTOTAB_RESOURCES_DIR>/bin before anything else,
# which is why these land here rather than on PATH: the app must use the build
# it ships with, not one someone later installs into the image.
COPY --from=ffmpeg /res/bin ./res/bin
COPY package.json server.js ./
COPY pipeline ./pipeline
COPY public ./public

# Everything mutable lives under /data: the work folder (VIDTOTAB_DATA_DIR/work)
# and the yt-dlp the server installs for itself on first run, because a yt-dlp
# baked into an image goes stale and starts failing in ways that read as broken
# links. /app stays read-only as far as the app is concerned.
#
# A volume mounted here from the host must be writable by uid 1000, or the
# server cannot create its work folder.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000

# No curl in this image, and none needed: node can ask itself. The body matters
# as much as the status — /api/health answers 200 with ok:false when ffmpeg is
# missing, which is a container that cannot do the one thing it is for.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>r.json()).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
