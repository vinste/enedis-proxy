FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app

COPY package.json .
RUN npm install

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY enedis-proxy-server.js .

EXPOSE 3001

CMD ["node", "enedis-proxy-server.js"]
