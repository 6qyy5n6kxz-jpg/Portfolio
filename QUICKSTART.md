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

These secrets power the `scripts/build_manifest.py` workflow.

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
GOOGLE_API_KEY=... GOOGLE_DRIVE_FOLDER_ID=... python scripts/build_manifest.py
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
