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

# Copy OHIF viewer (pre-built) + MiniPACS branding
COPY ohif-dist/ /usr/share/nginx/ohif/
COPY ohif-config/minipacs.js /usr/share/nginx/ohif/app-config.js
COPY ohif-config/minipacs-brand.css /usr/share/nginx/ohif/minipacs-brand.css
RUN sed -i 's|</head>|<link href="/ohif/minipacs-brand.css" rel="stylesheet"></head>|' /usr/share/nginx/ohif/index.html

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
