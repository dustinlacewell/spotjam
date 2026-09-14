FROM node:22-alpine

WORKDIR /app
# y-websocket 2.x is the last line that ships the relay server in-package,
# on yjs 13 (same major as the app's client). @y/websocket-server 0.1.x
# mixes two incompatible yjs 14 prereleases and throws on every update.
RUN npm install y-websocket@2.1.0 yjs@13.6.32 ws@8

ENV HOST=0.0.0.0
ENV PORT=4444
EXPOSE 4444

CMD ["node", "node_modules/y-websocket/bin/server.cjs"]
