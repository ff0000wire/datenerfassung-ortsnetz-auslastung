FROM node:24-slim
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --omit=dev
COPY ortsnetz-auslastung.js ./
USER node
CMD ["node", "ortsnetz-auslastung.js"]
