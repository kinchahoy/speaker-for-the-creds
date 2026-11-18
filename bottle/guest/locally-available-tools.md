# Tools in this VM

<sub>AI-written</sub>

Everything below is installed. Prefer these before installing anything. A missing tool or library comes from a package registry: `uv add` (PyPI) or `pnpm add` (npm).

This file is also the image's install list: `guest/Dockerfile` installs each `(<source> <package>)` and fails the build if a command named in backticks before the line's first `: ` is missing. Sources: `apt` (Debian), `base` (mise, needed before the browser layer), `browser` (mise, with Chromium), `mise`, `uv` (the default Python environment), `image` (shipped in the image's own files).

## Search and code

- `rg` (mise ripgrep): search file contents, fast; respects .gitignore
- `fdfind` (apt fd-find): find files by name
- `ctags` (apt universal-ctags): index symbols in a codebase
- `jq` (mise jq): query and reshape JSON
- `shellcheck` (mise shellcheck): lint shell scripts
- `hyperfine` (mise hyperfine): benchmark commands
- `tree` (apt tree): show a folder as a tree
- `file` (apt file): tell what kind of file something is
- `less` (apt less): page through long output
- `vi` (apt vim-tiny): edit a file by hand
- `parallel` (apt parallel): run many commands in parallel
- `strace` (apt strace): trace a program's system calls
- `lsof` (apt lsof): list open files and ports
- `ps` (apt procps): list processes

## Version control

- `git` (apt git): version control
- `git-lfs` (mise git-lfs): large files in git
- `gh` (mise gh): GitHub from the command line (needs the GitHub secret from speaker)

## Build

- `gcc`, `g++`, `make` (apt build-essential): compile C and C++
- `cmake` (apt cmake): configure C and C++ builds
- `ninja` (apt ninja-build): fast build runner
- `pkg-config` (apt pkg-config): find installed C libraries

## Python

Always use uv; there is no bare `pip`. Scratch code: `uv run python`, `uv run pytest` (default environment, `/opt/uv/venv`). A project: `uv init`, `uv add`, `uv run`.

- `uv` (base uv): Python packages, environments and Python itself
- `pytest` (uv pytest): tests
- pytest-asyncio (uv pytest-asyncio): async tests
- hypothesis (uv hypothesis): property-based tests
- `mypy` (uv mypy): type checking
- httpx (uv httpx), requests (uv requests): HTTP clients
- beautifulsoup4 (uv beautifulsoup4), lxml (uv lxml): parse HTML and XML
- fastapi (uv fastapi), `uvicorn` (uv uvicorn): web APIs and their server
- numpy (uv numpy), scipy (uv scipy), sympy (uv sympy): numbers, science, symbolic maths
- pandas (uv pandas), polars (uv polars), pyarrow (uv pyarrow): dataframes
- duckdb (uv duckdb): SQL over files and dataframes
- scikit-learn (uv scikit-learn): classic machine learning
- networkx (uv networkx): graphs
- matplotlib (uv matplotlib): charts
- pydantic (uv pydantic): typed data validation
- typer (uv typer), rich (uv rich), tqdm (uv tqdm): command-line apps, pretty output, progress bars
- python-dateutil (uv python-dateutil), pyyaml (uv pyyaml), orjson (uv orjson), jinja2 (uv jinja2): dates, YAML, fast JSON, templates
- openpyxl (uv openpyxl): Excel files
- pypdf (uv pypdf), pdfplumber (uv pdfplumber), reportlab (uv reportlab): read, split and write PDFs
- python-docx (uv python-docx), python-pptx (uv python-pptx): Word and PowerPoint files
- pillow (uv pillow): images

## JavaScript

Write TypeScript and run it with `node file.ts`. Check types with `tsc --noEmit`, lint with `oxlint`, format with `oxfmt` (add them with pnpm).

- `node` (base node): run JavaScript and TypeScript
- `pnpm` (mise pnpm): JavaScript packages

## Browser

- `agent-browser` (browser npm:agent-browser): browse and take screenshots. `agent-browser open <url>`, then `agent-browser snapshot -i` lists the page's elements as `@e1`, `@e2`…, then `agent-browser click @e1`, `fill @e2 "text"`, `screenshot page.png`. Snapshot again after the page changes. `agent-browser --help` for more.
- `playwright` (browser npm:playwright): Chromium for scripts and tests in Python or TypeScript

## Documents, images and media

- `pandoc` (mise pandoc): convert between Markdown, HTML, Word and more
- `pdftotext`, `pdftoppm` (apt poppler-utils): PDF to text or images
- `qpdf` (apt qpdf): split, merge and repair PDFs
- `tesseract` (apt tesseract-ocr): read text from images (OCR)
- (apt tesseract-ocr-eng): English for tesseract
- `magick` (apt imagemagick): convert, resize and annotate images
- `ffmpeg` (apt ffmpeg): convert and cut audio and video
- `mediainfo` (apt mediainfo): describe a media file
- `exiftool` (apt libimage-exiftool-perl): read and write image metadata
- `dot` (apt graphviz): draw graphs
- (apt fonts-dejavu-core), (apt fonts-liberation): fonts for rendering

## Data and files

- `sqlite3` (apt sqlite3): SQLite databases
- `zip` (apt zip), `unzip` (apt unzip), `xz` (apt xz-utils): archives
- `rsync` (apt rsync): copy folders efficiently

## Network and sessions

- `curl` (apt curl), `wget` (apt wget): fetch URLs (through bottle's proxy; only granted hosts answer)
- `speaker` (image speaker): call a speaker service you hold: `speaker [METHOD] <service>/<path> [json-body]`
- `tmux` (mise tmux): terminal sessions
- `ip` (apt iproute2): network interfaces

## Plumbing (bottle uses these; you rarely need them)

- `ssh` (apt openssh-client), `sshfs` (apt sshfs), (apt fuse3): folders from other machines
- `socat` (apt socat), `dtach` (apt dtach): bottle's doors and attach
- (apt ca-certificates), (apt tzdata): certificates and time zones
