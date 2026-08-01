# The elysium starter: one Next.js server in one container.
# Local mode: your wallet files are the only state. Mount a volume at /data; they are written to /data/wallets
# (the rule: nothing is funded unless its file is there). Pass QUICKNODE_API_KEY (or PINATA_JWT) for IPFS pins.
# Hosted demo mode (NEXT_PUBLIC_DEMO=1 at build, DEMO_MODE=1 at run): wallets live in each visitor's browser and
# this container holds nothing.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# hosted demo: docker build --build-arg NEXT_PUBLIC_DEMO=1 … and run with -e DEMO_MODE=1 (README: Hosted demo mode)
ARG NEXT_PUBLIC_DEMO=
ENV NEXT_PUBLIC_DEMO=$NEXT_PUBLIC_DEMO
# which edition the page opens on (ascend | montra | boxa); lib/brand.ts's PAD line when empty
ARG NEXT_PUBLIC_LAUNCHPAD=
ENV NEXT_PUBLIC_LAUNCHPAD=$NEXT_PUBLIC_LAUNCHPAD
RUN npm run build
# A deterministic marker for the runtime check below: minification could knock out any string we grep for.
RUN if [ "$NEXT_PUBLIC_DEMO" = "1" ]; then echo demo > public/.demo-build; fi

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 WALLET_BACKUP_DIR=/data/wallets
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
# Refuse to start in a state where the browser engine was not built but the server routes are open: that combination
# signs and sends from the container against a wallet folder on a shared host. Demo mode is fixed at build time, so the
# check is the marker the build wrote, not the runtime env. Local mode (no DEMO_MODE) skips the check.
CMD ["sh", "-c", "if [ \"$DEMO_MODE\" = \"1\" ] && [ ! -f /app/public/.demo-build ]; then echo 'DEMO_MODE=1 but this image was built without NEXT_PUBLIC_DEMO=1: the server routes would sign with a server-side wallet folder. Rebuild with --build-arg NEXT_PUBLIC_DEMO=1.' >&2; exit 1; fi; mkdir -p /data/wallets && node server.js"]
