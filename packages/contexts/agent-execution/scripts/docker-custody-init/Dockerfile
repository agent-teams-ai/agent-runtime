FROM node@sha256:86f07bc9c5dce4578cf37e5a418b7bfc7f817cda25cde66e2b66e95ed86c4567 AS base
FROM scratch
COPY --from=base / /
COPY --from=base --chown=0:0 --chmod=0555 /usr/local/bin/node /ar-custody-node
COPY --chown=0:0 --chmod=0444 ar-custody-init.mjs /ar-custody-init.mjs
USER 1000:1000
ENTRYPOINT ["/ar-custody-node", "--no-addons", "--no-global-search-paths", "/ar-custody-init.mjs"]
