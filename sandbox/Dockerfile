FROM node:22-alpine

RUN addgroup -S -g 65532 sandbox \
    && adduser -S -D -H -u 65532 -G sandbox sandbox

WORKDIR /runner
COPY --chown=65532:65532 runner.js /runner/runner.js
USER 65532:65532
ENTRYPOINT ["node", "--max-old-space-size=32", "/runner/runner.js"]
