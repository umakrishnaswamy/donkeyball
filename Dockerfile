FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
RUN mkdir -p /data
ENV DATA_FILE=/data/data.json
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
