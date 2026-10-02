FROM node:22-slim
WORKDIR /app
COPY . .
RUN chown -R node:node /app
USER node
ENV PORT=7860
EXPOSE 7860
CMD ["node","server.js"]
