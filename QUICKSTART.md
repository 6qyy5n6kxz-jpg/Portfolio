# Quick Start

This walkthrough gets the manifest pipeline and static gallery live in minutes.

## 1. Prep Google Drive & API Key

1. Create a folder in Google Drive for your portfolio (subfolders allowed).
2. Share it **Anyone with the link → Viewer**.
3. In [Google Cloud Console](https://console.cloud.google.com/):
   - Create a project.
   - Enable the **Google Drive API**.
   - Create an **API key** → Restrict to the Drive API (optionally restrict by IP ranges for GitHub Actions).
4. Copy the folder ID (the string after `/folders/` in the Drive URL).

## 2. Configure GitHub secrets

Repository → **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Value |
|------|-------|
| `GOOGLE_API_KEY` | Your API key |
| `GOOGLE_DRIVE_FOLDER_ID` | The folder ID copied above |
| `OPENAI_API_KEY` | *(Optional)* GPT API key for premium tagging accuracy |

These secrets power the `scripts/build_manifest.py` workflow.

Optional **repository variables** to smooth out rate limits when running GPT tagging:

| Variable | Example | Description |
|----------|---------|-------------|
| `OPENAI_REQUEST_INTERVAL` | `20` | Wait this many seconds between GPT calls (handy on free-tier limits). |
| `OPENAI_MAX_RETRIES` | `10` | Retry attempts before falling back to TensorFlow. |
| `OPENAI_BACKOFF_SECONDS` | `20` | Additional delay inserted when a rate-limit response is returned. |
| `MAX_ITEMS_PER_RUN` | `50` | Process only this many new/changed images per run; leave unset once the backlog is caught up. |

## 3. Adjust UI config

Update `public/config.json` with your preferred title and optional page size:

```json
{
  "title": "My Photo Gallery",
  "ITEMS_PER_PAGE": 30
}
```

## 4. First manifest build

You can wait for the nightly schedule, or trigger it manually:

```
gh workflow run "Build Photo Gallery Manifest"
```

or through the GitHub Actions UI. The workflow will download, analyse, and commit `public/manifest.json`.

## 5. Deploy via GitHub Pages

1. Push your changes to GitHub (`git add . && git commit && git push`).
2. In the repo: **Settings → Pages → Build and deployment → Deploy from branch → main**.
3. After the workflow commits the manifest, visit `https://<username>.github.io/<repo>/`.

## 6. Add new images

1. Upload photos to the Drive folder (keeping subfolders if desired).
2. Either wait for the scheduled build or trigger the workflow immediately.
3. Once the manifest commit lands on `main`, refresh your site (hard refresh to bypass browser cache).

## Local smoke test (optional)

```bash
python -m http.server 8000
# open http://localhost:8000 in a browser
```

If you want to generate the manifest locally first:

```bash
pip install -r requirements.txt
GOOGLE_API_KEY=... GOOGLE_DRIVE_FOLDER_ID=... OPENAI_API_KEY=sk-xxx python scripts/build_manifest.py
```

Set `SKIP_AI=1` for a faster dry run that reuses cached tags.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Workflow fails with `Drive API error` | Confirm the folder is shared publicly, secrets are correct, and the API key is restricted to the Drive API only. |
| `public/manifest.json` missing | Trigger the workflow manually; ensure there are no merge conflicts preventing the commit. |
| Gallery shows “Failed to load gallery” | Make sure GitHub Pages is serving the latest `main` branch and that the manifest exists. |
| TensorFlow install takes too long | Add pip caching to the workflow (`cache: 'pip'` in `actions/setup-python`) or run on a faster runner. |

Need more detail? See [README.md](README.md) for architecture and maintenance guidance.

## Optional: instant rebuilds

The manifest workflow also listens for a repository dispatch named `refresh-manifest`. Use it to regenerate the manifest whenever new images land in Drive:

```bash
curl -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  https://api.github.com/repos/6qyy5n6kxz-jpg/Portfolio/dispatches \
  -d '{"event_type":"refresh-manifest"}'
```

Create a GitHub personal access token with the `repo` scope and keep it secure (e.g., Google Apps Script project properties). Call this endpoint from your automation whenever you upload new photos.
