FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends gh ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY src ./src
EXPOSE 3000
USER node
ENV GH_CONFIG_DIR=/home/node/.config/gh
CMD ["node", "src/http.mjs"]
