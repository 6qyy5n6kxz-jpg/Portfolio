#!/usr/bin/env python3
"""
Build manifest.json from Google Drive folder
Used by GitHub Actions to generate a static manifest for fast gallery loading
"""

import os
import sys
import json
from datetime import datetime
from urllib.parse import urlparse
import urllib.request
import urllib.error


def get_google_drive_files(folder_id: str, api_key: str) -> list:
    """
    Query Google Drive API v3 to list image files in folder.
    Returns list of file metadata.
    """
    image_extensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp']
    
    # Build API query
    query = f"'{folder_id}' in parents and trashed=false"
    fields = 'files(id,name,mimeType,createdTime,modifiedTime,webViewLink)'
    
    url = (
        f"https://www.googleapis.com/drive/v3/files?"
        f"q={urllib.parse.quote(query)}&"
        f"fields={urllib.parse.quote(fields)}&"
        f"key={api_key}&"
        f"pageSize=1000"
    )
    
    try:
        print(f"[API] Querying Google Drive folder: {folder_id}")
        with urllib.request.urlopen(url) as response:
            data = json.loads(response.read().decode())
        
        # Filter for image files
        files = data.get('files', [])
        image_files = [
            f for f in files
            if f['name'].split('.')[-1].lower() in image_extensions
        ]
        
        print(f"[API] Found {len(image_files)} image files")
        return image_files
    
    except urllib.error.URLError as e:
        print(f"[API Error] {e.reason}", file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"[API Error] Invalid JSON response: {e}", file=sys.stderr)
        sys.exit(1)


def extract_season_from_date(date_str: str) -> str:
    """Derive season from ISO date string."""
    try:
        date_obj = datetime.fromisoformat(date_str.replace('Z', '+00:00'))
        month = date_obj.month
        if 2 <= month <= 4:
            return 'Spring'
        elif 5 <= month <= 7:
            return 'Summer'
        elif 8 <= month <= 10:
            return 'Fall'
        else:
            return 'Winter'
    except (ValueError, AttributeError):
        return 'Unknown'


def extract_year_from_date(date_str: str) -> int:
    """Extract year from ISO date string."""
    try:
        date_obj = datetime.fromisoformat(date_str.replace('Z', '+00:00'))
        return date_obj.year
    except (ValueError, AttributeError):
        return datetime.now().year


def build_manifest_entry(file_metadata: dict) -> dict:
    """
    Build a manifest entry from Drive file metadata.
    Performs minimal processing (no heavy ML here).
    """
    file_id = file_metadata['id']
    name = file_metadata['name']
    
    # Remove file extension from name
    name_without_ext = '.'.join(name.split('.')[:-1])
    
    # Derive season and year from createdTime
    created_time = file_metadata.get('createdTime', '')
    season = extract_season_from_date(created_time)
    year = extract_year_from_date(created_time)
    
    return {
        'id': file_id,
        'name': name_without_ext,
        'src': f'https://lh3.googleusercontent.com/d/{file_id}=w800',
        'view': file_metadata.get('webViewLink', ''),
        'createdTime': created_time,
        'modifiedTime': file_metadata.get('modifiedTime', ''),
        'mimeType': file_metadata.get('mimeType', ''),
        'season': season,
        'year': year,
        'tags': [],  # ML tagging done client-side
        'difficulty': 'Medium',  # Default, refined client-side
        'color': 'Neutral',  # Default, refined client-side
    }


def main():
    """Main entry point."""
    # Read from environment (set by GitHub Actions secrets)
    api_key = os.getenv('GOOGLE_API_KEY')
    folder_id = os.getenv('GOOGLE_DRIVE_FOLDER_ID')
    
    if not api_key or not folder_id:
        print(
            "[Error] Missing GOOGLE_API_KEY or GOOGLE_DRIVE_FOLDER_ID "
            "environment variables",
            file=sys.stderr
        )
        sys.exit(1)
    
    print("[Build] Starting manifest generation...")
    
    # Fetch files from Google Drive
    files = get_google_drive_files(folder_id, api_key)
    
    # Build manifest entries
    manifest = [build_manifest_entry(f) for f in files]
    
    # Sort by year (newest first) then by name
    manifest.sort(key=lambda x: (-x['year'], x['name']))
    
    # Write to public/manifest.json
    output_path = 'public/manifest.json'
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    
    with open(output_path, 'w') as f:
        json.dump(manifest, f, indent=2)
    
    print(f"[Build] Manifest written to {output_path}")
    print(f"[Build] Total images: {len(manifest)}")
    print("[Build] Success!")


if __name__ == '__main__':
    main()
