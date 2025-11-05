# Quick Start Guide

## Step 1: Get Your Google Drive Folder ID

1. Create a **new public folder** in Google Drive
2. Open it and copy the URL: `https://drive.google.com/drive/folders/{FOLDER_ID}`
3. Save the `FOLDER_ID`

## Step 2: Create Google Cloud API Key

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (name it anything)
3. Search for "Google Drive API" and **Enable** it
4. Go to **Credentials** → **Create Credentials** → **API Key**
5. Copy your API key
6. Click **Restrict key** and set:
   - **API restrictions**: Google Drive API
   - **HTTP referrers**: `*.github.io/*` (restrict to your GitHub Pages domain)

## Step 3: Fill config.json

Edit `public/config.json`:

```json
{
  "title": "My Photo Gallery",
  "GOOGLE_DRIVE_FOLDER_ID": "paste-your-folder-id",
  "GOOGLE_API_KEY": "paste-your-api-key",
  "ITEMS_PER_PAGE": 20,
  "enableMLTagging": true
}
```

## Step 4: Set Up GitHub Secrets (for auto-updating manifest)

In GitHub repository → **Settings** → **Secrets and variables** → **Actions secrets**:

- Add `GOOGLE_API_KEY` = your API key
- Add `GOOGLE_DRIVE_FOLDER_ID` = your folder ID

This enables the nightly workflow to auto-generate `public/manifest.json`.

## Step 5: Deploy

```bash
git add .
git commit -m "Initial photo gallery setup"
git push origin main
```

Then go to repository **Settings** → **Pages** → Deploy from `main` branch.

Your gallery will be live in a few minutes at: `https://your-username.github.io/my-portfolio`

## Step 6: Add Images

1. Upload photos to your Google Drive folder
2. Make sure the folder is **public** (anyone with link)
3. Either wait for nightly workflow to run, or manually trigger:
   - Go to **Actions** → **Build Photo Gallery Manifest** → **Run workflow**
4. Refresh your gallery page (Ctrl+Shift+R to clear cache)

## Testing Locally

```bash
# Install a simple HTTP server
python -m http.server 8000

# Open http://localhost:8000 in browser
```

The gallery loads fine locally, but Google Drive API requests may need CORS headers adjusted.

## Troubleshooting

### "Failed to load gallery"
- Check browser console (F12) for error messages
- Ensure `public/config.json` has correct credentials
- Verify Drive folder is public

### Images not showing
- Drive folder must be **public**
- Try refreshing with Cmd+Shift+R (hard refresh)

### ML tagging not working
- Check HTTPS is enabled (GitHub Pages uses HTTPS)
- Large images slow down tagging
- Disable it in `config.json`: `"enableMLTagging": false`

For more help, see [README.md](README.md).
