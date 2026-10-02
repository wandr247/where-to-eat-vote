FROM node:22-slim
WORKDIR /app
COPY . .
# Runs as root so the mounted volume (/data) is writable; Railway volumes are root-owned.
ENV PORT=7860
EXPOSE 7860
CMD ["node","server.js"]
