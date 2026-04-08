FROM mcr.microsoft.com/playwright:v1.42.0-jammy

WORKDIR /app

COPY package.json .
RUN npm install

# Playwright browsers déjà inclus dans l'image de base
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY enedis-proxy-server.js .

EXPOSE 3001

CMD ["node", "enedis-proxy-server.js"]
