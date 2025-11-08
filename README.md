# Photo Gallery — Automated Portfolio Pipeline

A modern static gallery tailored for large photo catalogs ( ~1.4k images ) hosted on GitHub Pages. The site consumes a pre-built `manifest.json` that already contains AI-generated tags, difficulty scores, seasons, dominant colors, EXIF camera data, and orientation metadata. A GitHub Actions workflow keeps that manifest in sync with your Google Drive portfolio so new uploads are automatically tagged and published.

## Highlights

- **Zero-runtime AI** – GPT-powered tagging (via `OPENAI_API_KEY`) generates rich descriptions, precise tags, and difficulty scores server-side; falls back to TensorFlow MobileNet if GPT is unavailable.
- **Drive recursion** – The manifest builder walks your Drive tree (including subfolders) and retains relative paths so collections can stay organised.
- **Fast client UX** – The browser only parses JSON; no EXIF reads, ML downloads, or Drive requests at runtime. Filters, search, and pagination stay instant even for thousands of assets.
- **Automated publishing** – A scheduled GitHub Action regenerates the manifest, commits the results, and redeploys the static site. Hook it into Drive webhooks or a Google Apps Script to refresh immediately on new uploads.
- **Configurable filters** – Season, difficulty (1–5), orientation, colour palette, and free‑text search across titles, tags, camera, and lens fields.

## Architecture Overview

```
+----------------------+        +----------------------+        +----------------------+
|  Google Drive Folder |  ==>   |  scripts/build_*.py |  ==>   |  public/manifest.json|
+----------------------+        +----------------------+        +----------------------+
         ▲                                 │                              │
         │  (API key & folder ID)          │ GitHub Action (nightly/manual│
         │                                 ▼                              ▼
   Google Cloud Project            GitHub Actions Workflow           GitHub Pages Site
```

1. `scripts/build_manifest.py` lists every image (recursively) in the Drive folder using an API key restricted to that folder. Files are treated as images if either (a) their name ends with one of the supported extensions (`jpg`, `jpeg`, `png`, `gif`, `webp`, `bmp`) or (b) Drive reports their MIME type as `image/*`, so you can keep extensionless file names if you prefer.
2. For items whose Drive `modifiedTime` or internal AI version changed, it downloads the asset, sends it to OpenAI Vision (or TensorFlow MobileNet fallback) for tagging, extracts EXIF data with Pillow, infers colour, and writes the enriched record.
3. The workflow commits `public/manifest.json` back to the repo so GitHub Pages serves a fully tagged dataset.
4. `app.js` simply loads the manifest, builds filters, and renders the grid – no client-side ML or Drive calls required.

## Getting Started

### 1. Prepare Google Drive & Cloud Project

1. Create (or identify) the Drive folder containing your portfolio. If you use subfolders to group sets, leave the structure intact – the manifest stores the relative path.
2. In the [Google Cloud Console](https://console.cloud.google.com/):
   - Create a project.
   - Enable the **Google Drive API**.
   - Create an **API key**. Lock it down to the Drive API and (optionally) to the public IP ranges used by GitHub Actions.
3. Make the folder readable for “anyone with the link”. The manifest builder only accesses public assets via the API key.

### 2. Configure secrets for GitHub Actions

In your repository → **Settings** → **Secrets and variables** → **Actions**:

| Secret | Description |
|--------|-------------|
| `GOOGLE_API_KEY` | API key generated above. |
| `GOOGLE_DRIVE_FOLDER_ID` | The root folder ID (string after `/folders/` in the Drive URL). |
| `OPENAI_API_KEY` | (Optional) Enables GPT-based tagging for richer, more accurate metadata. |

Optional GitHub **repository variables** (Settings → Secrets and variables → Actions → Variables) let you fine-tune rate limiting:

| Variable | Suggested value | Purpose |
|----------|-----------------|---------|
| `OPENAI_REQUEST_INTERVAL` | `20` (seconds) | Sleep between GPT calls if you have a low requests-per-minute quota. |
| `OPENAI_MAX_RETRIES` | `10` | Number of times to retry GPT before falling back to TensorFlow. |
| `OPENAI_BACKOFF_SECONDS` | `20` | How long to pause after a rate-limit response before retrying. |
| `MAX_ITEMS_PER_RUN` | `50` | Optional cap on how many images get fresh AI tagging per workflow run. Useful for working through large backlogs without hitting rate limits. |

### 3. Local configuration

`public/config.json` controls UI-facing options. Only the gallery title and optional paging size remain:

```json
{
  "title": "My Photo Gallery",
  "ITEMS_PER_PAGE": 30
}
```

### 4. Install dependencies (optional local runs)

The manifest builder uses TensorFlow (fallback) and Pillow. Provide an `OPENAI_API_KEY` for the highest-quality GPT tagging. To test locally:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
GOOGLE_API_KEY=xxxx GOOGLE_DRIVE_FOLDER_ID=yyyy OPENAI_API_KEY=sk-xxx python scripts/build_manifest.py
```

When `SKIP_AI=1` the script skips heavy downloads and simply reuses cached metadata – handy for dry runs.

### 5. Deploy via GitHub Pages

Push the repository, enable **Settings → Pages → Deploy from branch → main**, and the static site will update after each commit. The workflow (`.github/workflows/build-manifest.yml`) runs nightly and on manual dispatch; extend it with repository dispatch or Apps Script webhooks for near real-time updates.

## Manifest Schema

Each record in `public/manifest.json` follows this shape:

```jsonc
{
  "id": "drive-file-id",
  "name": "Image Title",
  "path": "Landscapes/2024",
  "src": "https://lh3.googleusercontent.com/d/{id}=w1200",
  "view": "https://drive.google.com/file/d/{id}",
  "createdTime": "2024-10-12T18:05:22Z",
  "modifiedTime": "2024-10-12T18:05:22Z",
  "mimeType": "image/jpeg",
  "season": "Fall",
  "year": 2024,
  "tags": ["Fall", "Mountain", "Sunset"],
  "difficulty": 3,
  "color": "Orange",
  "orientation": "Landscape",
  "width": 2048,
  "height": 1365,
  "camera": "Canon EOS R5",
  "lens": "RF24-70mm F2.8 L IS USM",
  "dateTime": "2024:10:12 18:05:22",
  "description": "A glowing sunset illuminates a winding river and village beneath a starry sky.",
  "aiVersion": "2025-03-20"
}
```

The `aiVersion` field lets the pipeline invalidate cache entries when tagging logic changes.

## Frontend Behaviour (`app.js`)

- Loads configuration and cached manifest (`localStorage` with a v2 key).
- Falls back to `public/manifest.json` on first load. If the file is missing it surfaces an error prompting a rebuild.
- Builds filter chips for season, difficulty (1–5), orientation, and colour, preserving active selections when the dataset refreshes.
- Full-text search scans title, tags, camera, and lens data.
- Pagination remains configurable (`ITEMS_PER_PAGE`), with graceful empty states and accessible keyboard controls.

## Operations Playbook

### Triggering a manual refresh

```
gh workflow run "Build Photo Gallery Manifest"
```

or use the **Actions → Build Photo Gallery Manifest → Run workflow** button.

### Instant refresh via API (optional)

The workflow now listens for a `repository_dispatch` event. You can trigger it automatically whenever new photos are uploaded:

1. **Create a GitHub personal access token** (classic or fine-grained) with the `repo` scope.
2. Store it somewhere safe (for example, in Google Apps Script project properties).
3. Call the dispatch API:

```bash
curl -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  https://api.github.com/repos/6qyy5n6kxz-jpg/Portfolio/dispatches \
  -d '{"event_type":"refresh-manifest"}'
```

The workflow will rebuild the manifest immediately.

### Accelerating updates when new images are added

1. **Scheduled build** (default): runs nightly at 02:00 UTC.
2. **Push button**: trigger manually after a batch upload.
3. **Drive webhook** (recommended): Connect Google Apps Script or another automation tool to the Drive folder so it calls the dispatch API above whenever new images are added. Store the GitHub token in the script’s secure properties.
4. **Batching strategy**: On large backlogs, set `MAX_ITEMS_PER_RUN` (e.g., 50) so each run only sends a manageable number of images to GPT. The cache ensures already-tagged shots skip future runs automatically.

### Monitoring

- Workflow logs show counts of discovered assets, how many required reprocessing, and any failures that fell back to cached metadata.
- Manifest commits are tagged `chore: update manifest [skip ci]` for easy filtering.
- Consider enabling GitHub notifications for failed workflows so you catch API quota issues quickly.

## Troubleshooting

| Symptom | Resolution |
|---------|------------|
| Workflow fails with `Drive API error` | Validate the API key restrictions and confirm the folder is shared publicly. Also ensure the folder ID secret is correct. |
| TensorFlow install times out | The CPU build is ~250 MB. Add a pip cache (`actions/setup-python` `cache: pip`) or host the job on a runner with more bandwidth if builds routinely fail. |
| Manifest missing or stale | Run the workflow manually, or verify no merge conflicts prevented the commit. Stale manifest entries can be forced to rebuild by bumping `AI_VERSION` in `scripts/build_manifest.py`. |
| Gallery shows “Failed to load gallery” | Confirm `public/manifest.json` exists in the branch served by GitHub Pages and that the browser isn’t blocked by CORS/ad blockers. |

## Roadmap Ideas

- Add a “Collections” filter derived from the Drive subfolder path.
- Implement incremental rendering/virtualisation for extreme catalog sizes.
- Surface download/licensing links per image by extending the manifest schema.
- Wire in analytics or contact forms to capture customer leads straight from the gallery.

---

Questions or improvements? Open an issue or tweak `scripts/build_manifest.py` and submit a PR. Happy shooting!
