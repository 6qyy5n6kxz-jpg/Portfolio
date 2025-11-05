import os, json, math, requests, time
from datetime import datetime

API_KEY = os.environ.get("GOOGLE_API_KEY")
FOLDER_ID = os.environ.get("GOOGLE_DRIVE_FOLDER_ID")

def month_to_season(m):
    if m in [12,1,2]: return "Winter"
    if m in [3,4,5]: return "Spring"
    if m in [6,7,8]: return "Summer"
    if m in [9,10,11]: return "Fall"
    return ""

def infer_difficulty(tags):
    t = set([x.lower() for x in tags])
    hard = ['night','milky way','stars','macro','macro photography','action','sports','long exposure','light trails','underwater']
    moderate = ['low light','wildlife','telephoto','waterfall','sunset','sunrise']
    if any(k in t for k in hard): return 'hard'
    if any(k in t for k in moderate): return 'moderate'
    return 'easy'

def list_drive_files():
    base = "https://www.googleapis.com/drive/v3/files"
    q = f"'{FOLDER_ID}' in parents and trashed=false and (mimeType contains 'image/')"
    params = {
        "q": q,
        "fields": "files(id,name,mimeType,thumbnailLink,webViewLink,webContentLink,modifiedTime,createdTime,md5Checksum),nextPageToken",
        "pageSize": 1000,
        "key": API_KEY
    }
    out = []
    token = None
    while True:
        if token: params["pageToken"] = token
        r = requests.get(base, params=params)
        r.raise_for_status()
        data = r.json()
        out.extend(data.get("files", []))
        token = data.get("nextPageToken")
        if not token: break
    return out

# Cheap tagging using a public wordlist + filename hints (keeps action fast & free)
HINTS = {
    "night": ["night","astro","stars","milkyway","milky_way","aurora"],
    "macro": ["macro","closeup","close-up"],
    "waterfall": ["falls","waterfall"],
    "wildlife": ["eagle","bear","deer","fox","wolf","bird","owl"],
    "sports": ["surf","mtb","bmx","soccer","basketball","football","hockey","ski","snowboard","skate"],
    "sunset": ["sunset","goldenhour","golden-hour"],
    "sunrise": ["sunrise"],
    "underwater": ["underwater","scuba","diving","snorkel"],
    "long exposure": ["longexposure","long-exposure","lighttrails","light-trails"]
}

def tags_from_name(name):
    n = name.lower()
    tags = []
    for tag, keys in HINTS.items():
        if any(k in n for k in keys):
            tags.append(tag)
    return tags

def build_manifest():
    files = list_drive_files()
    items = []
    for f in files:
        src = f.get("webContentLink")
        if src:
            src += f"&key={API_KEY}"
        url = f.get("thumbnailLink") or src
        # date → season/year (Drive created/modified time)
        dt = f.get("createdTime") or f.get("modifiedTime")
        year = season = ""
        if dt:
            d = datetime.fromisoformat(dt.replace("Z","+00:00"))
            year = str(d.year)
            season = month_to_season(d.month)
        # ultra-fast file-name-based tags (browser will refine with MobileNet if enabled)
        tags = tags_from_name(f.get("name",""))
        items.append({
            "id": f.get("id"),
            "name": f.get("name"),
            "src": src or url,
            "view": f.get("webViewLink"),
            "tags": tags,
            "season": season,
            "year": year,
            "difficulty": infer_difficulty(tags),
            "orientation": "",  # client fills on render
            "color": "",
            "camera": "",
            "lens": "",
            "width": 0,
            "height": 0
        })
    return items

if __name__ == "__main__":
    m = build_manifest()
    os.makedirs("public", exist_ok=True)
    with open("public/manifest.json","w") as f:
        json.dump(m, f)
    print(f"Wrote {len(m)} items to public/manifest.json")
