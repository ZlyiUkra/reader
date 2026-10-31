# Contract: Compose topology

One file, `compose.yaml`, five services plus two one-off services. Exact image tags and digests are fixed in
[research.md](../research.md) and copied here by the plan; the prototype never uses a floating tag.

| Service | Image | Networks | Ports | Notes |
| --- | --- | --- | --- | --- |
| `db` | pgvector/pgvector (PostgreSQL 17) | `backend` | none | volume `pgdata`; init SQL creates the `app` role without superuser and the `schema_version` row |
| `model` | ollama/ollama, exact tag >= 0.31.2 | `backend` | none | volume `models`; GPU via NVIDIA Container Toolkit; `OLLAMA_CONTEXT_LENGTH` (the same number as `thresholds.model.num_ctx`; the app verifies they agree at readiness, llm-port.md), `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_KEEP_ALIVE` |
| `model-pull` | same image as `model` | `egress` | none | one-off; `ollama pull qwen3.5:4b` into `models`; exits 0 when the digest is already present; `profiles: [pull]` or `depends_on` with `service_completed_successfully` |
| `parser` | own image (Debian slim + LibreOffice without Java, poppler, Tesseract ukr+eng, librsvg, ImageMagick, img2pdf, file, fonts) | none (`network_mode: none`) | none | `read_only: true`, `user: 10001:10001`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, `mem_limit`, `pids_limit`, `tmpfs: [/tmp:size=512m, /home/parser:size=64m]`; volume `jobs` with `in` read-only; `# TODO runtime: runsc` |
| `app` | own image (node 24 slim) | `backend`, `ui` | `127.0.0.1:3000:3000` | API, worker, static front; env `READER_SANDBOX_RUNTIME=runc` (the parser's runtime, reported by `/api/health`); volumes `blobs`, `jobs`, `results`; bind mounts read-only: the inbox (with `expected/`), `./config`, `./schemas`; a schema or config change needs a restart, not a rebuild (acceptance check 10, T067) |
| `fixtures` | the parser image, second build target | none | none | one-off; bind mounts: the inbox read-write (writes the fixtures, `manifest.json` and `expected/<sha256>.json`), `./schemas` read-only; `profiles: [fixtures]` |

Networks: `backend` with `internal: true`; `egress` default bridge for `model-pull` only; `ui` default bridge that
carries the single published port. Port 11434 and 5432 are never published (acceptance check 3).

Volumes: `pgdata`, `models`, `blobs`, `jobs`, `results`. `docker compose down -v` is the schema reset.

Build: both own images use the repository root as build context (`build: { context: ., dockerfile: app/Dockerfile }`;
`dockerfile: parser/Dockerfile` with `target: parser` or `target: fixtures`), so the parser's `fixtures` target can
copy `app/src/shared/`. `config/` and `schemas/` are never copied into an image: they are the bind mounts above.

Health: `app` starts without waiting for `model`; `/api/health` reports the model state (C5). `db` has a
`pg_isready` healthcheck and `app` waits for it.

Secrets: none in images; the database password comes from `.env` (never printed); `.env.example` ships
placeholders.
