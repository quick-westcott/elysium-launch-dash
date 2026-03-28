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

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 WALLET_BACKUP_DIR=/data/wallets
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
# mount a volume at /data (docker run -v …:/data); declared here as a comment so platforms that manage volumes (Railway) accept the file
CMD ["sh", "-c", "mkdir -p /data/wallets && node server.js"]
