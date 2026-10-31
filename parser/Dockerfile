# The parser sandbox image and the fixtures generator image (C9, C17): the only programs that open document bytes.
# Build context is the repository root: `docker build -f parser/Dockerfile --target parser .`
# Targets: parser (default, the long-lived service), fixtures (one-off generator), check (type check).
# The Node base is the same digest as the app image: Debian's own nodejs package is too old for type stripping.
ARG NODE_IMAGE=node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

# Document tools, exact bookworm versions of research R4. Java stays out: libreoffice-writer-nogui only suggests a JRE
# and apt never installs suggestions; --no-install-recommends also drops the recommended extras the converter does not
# need, and the constitution forbids optional runtimes.
FROM ${NODE_IMAGE} AS tools
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libreoffice-writer-nogui=4:7.4.7-1+deb12u14 \
      libreoffice-calc-nogui=4:7.4.7-1+deb12u14 \
      poppler-utils=22.12.0-2+deb12u3 \
      tesseract-ocr=5.3.0-2 \
      tesseract-ocr-ukr=1:4.1.0-2 \
      tesseract-ocr-eng=1:4.1.0-2 \
      librsvg2-bin=2.54.7+dfsg-1~deb12u1 \
      imagemagick=8:6.9.11.60+dfsg-1.6+deb12u14 \
      img2pdf=0.4.4-3 \
      qpdf=11.3.0-1+deb12u1 \
      file=1:5.44-3 \
      fonts-dejavu-core=2.37-6 \
      fonts-liberation=1:1.07.4-11 \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 parser \
 && useradd --uid 10001 --gid 10001 --home-dir /home/parser --no-create-home --shell /usr/sbin/nologin parser

# Type check (dev dependencies only: typescript and the Node typings; the sandbox itself has no packages).
FROM ${NODE_IMAGE} AS check
WORKDIR /build/parser
COPY parser/package.json parser/yarn.lock ./
RUN yarn install --frozen-lockfile --ignore-scripts --non-interactive
COPY parser/ ./
# app/package.json sits above shared/ as in the repository, so tsc reads those files as modules, not as CommonJS.
COPY app/package.json /build/app/package.json
COPY app/src/shared /build/app/src/shared
RUN yarn typecheck

# The generator reuses the checksum code of the app, kept at the same relative path as in the repository
# (../app/src/shared from the parser folder) so the same imports work on the host and in the container.
FROM tools AS fixtures
WORKDIR /srv/parser
COPY parser/package.json ./
COPY parser/fixtures ./fixtures
COPY app/package.json /srv/app/package.json
COPY app/src/shared /srv/app/src/shared
USER 10001:10001
CMD ["node", "fixtures/generate.ts"]

# The last stage is the default target: the service, not the generator.
FROM tools AS parser
# /jobs is shared with the app (group 10001, setgid); /jobs/in is mounted read-only over it by compose.yaml.
RUN mkdir -p /jobs/in && chown -R 10001:10001 /jobs && chmod 2775 /jobs /jobs/in
WORKDIR /srv/parser
COPY parser/package.json ./
COPY parser/src ./src
# Tells the server it owns its uid: after each job every other process of that uid is a leftover and is killed.
ENV PARSER_SANDBOX=1
USER 10001:10001
CMD ["node", "src/server.ts"]
