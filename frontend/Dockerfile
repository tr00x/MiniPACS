# Stage 1: Build React app
FROM node:20-alpine AS build

WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ .
RUN npm run build

# Stage 2: nginx serves React + OHIF + reverse proxy
FROM nginx:alpine

# Install envsubst (part of gettext)
RUN apk add --no-cache gettext

# Copy built React app
COPY --from=build /app/dist /usr/share/nginx/html

# Copy OHIF viewer (pre-built)
COPY ohif-dist/ /usr/share/nginx/ohif/

# Copy nginx template
COPY nginx/nginx-docker.conf /etc/nginx/templates/nginx.conf.template

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
CMD ["/bin/sh", "-c", "envsubst '${ORTHANC_BASIC_AUTH} ${HTTPS_PORT}' < /etc/nginx/templates/nginx.conf.template > /etc/nginx/nginx.conf && nginx -g 'daemon off;'"]
