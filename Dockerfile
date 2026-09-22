# ============================================================
# PHARAOH Backend — Dockerfile per Coolify
# ============================================================
# Deploy su Coolify:
#   1. Collega il repository Git a Coolify
#   2. Coolify rileva il Dockerfile automaticamente
#   3. Imposta le variabili d'ambiente nel pannello Coolify
#   4. Coolify builda e deploya automaticamente ad ogni push
# ============================================================

FROM node:24-alpine

ENV NODE_ENV=production

# Metadata
LABEL maintainer="PHARAOH"
LABEL description="Backend PHARAOH — Economia circolare a 1+5 livelli"

# Directory di lavoro
WORKDIR /app

# Installa dipendenze (prima del codice per sfruttare la cache Docker)
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copia il codice sorgente (escludi .dockerignore)
COPY --chown=node:node . .

# L'applicazione non necessita privilegi root a runtime.
USER node

# Porta esposta (deve corrispondere a PORT nel .env di Coolify)
EXPOSE 4000

# Health check per Coolify
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT||4000) + '/api/health', r => process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Applica in modo idempotente le migrazioni sotto advisory lock, poi avvia.
CMD ["sh", "-c", "npm run db:migrate && exec node api-server.js"]
