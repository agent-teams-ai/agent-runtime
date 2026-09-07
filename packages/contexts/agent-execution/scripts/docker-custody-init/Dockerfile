FROM node@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS base
FROM scratch
COPY --from=base / /
COPY --from=base --chown=0:0 --chmod=0555 /usr/local/bin/node /ar-custody-node
COPY --chown=0:0 --chmod=0444 ar-custody-init.mjs /ar-custody-init.mjs
USER 1000:1000
ENTRYPOINT ["/ar-custody-node", "--no-addons", "--no-global-search-paths", "/ar-custody-init.mjs"]
