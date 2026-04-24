# Stage 1: Build React app
FROM node:20-alpine AS build

WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
# --legacy-peer-deps: vite-plugin-pwa@1.2.0 declares vite ^5 || ^6 || ^7 || ^8
# but npm's strict resolver confuses itself with tailwindcss/vite's overlapping
# range. The lockfile is self-consistent; legacy resolver installs cleanly.
RUN npm ci --legacy-peer-deps
COPY frontend/ .
RUN npm run build

# Stage 2: nginx serves React + OHIF + reverse proxy
FROM nginx:alpine

# Install envsubst (part of gettext)
RUN apk add --no-cache gettext

# Copy built React app
COPY --from=build /app/dist /usr/share/nginx/html

# OHIF viewer is served by the Orthanc OHIF plugin (proxied through nginx
# at /ohif/). No static bundle baked into this image anymore.

# Copy nginx templates (dev with TLS, prod HTTP-only for CF Tunnel)
COPY nginx/nginx-docker.conf /etc/nginx/templates/nginx-dev.conf.template
COPY nginx/nginx-prod.conf /etc/nginx/templates/nginx-prod.conf.template

# Self-signed certs generated at build time (override with real certs via volume)
RUN mkdir -p /etc/ssl/minipacs && \
    apk add --no-cache openssl && \
    openssl req -x509 -newkey rsa:2048 -keyout /etc/ssl/minipacs/key.pem \
      -out /etc/ssl/minipacs/cert.pem -days 365 -nodes \
      -subj "/CN=minipacs.local" && \
    apk del openssl

RUN rm -f /etc/nginx/conf.d/default.conf

EXPOSE 80 443

# envsubst replaces $ORTHANC_BASIC_AUTH and $HTTPS_PORT in nginx config at startup
CMD ["/bin/sh", "-c", "TEMPLATE=${NGINX_TEMPLATE:-nginx-dev}; envsubst '${ORTHANC_BASIC_AUTH} ${HTTPS_PORT}' < /etc/nginx/templates/${TEMPLATE}.conf.template > /etc/nginx/nginx.conf && nginx -g 'daemon off;'"]
