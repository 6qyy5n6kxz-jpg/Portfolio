#!/usr/bin/env python3
"""
Generate a fully enriched manifest.json for the photo gallery.

Responsibilities
----------------
1. Traverse a Google Drive folder (including sub-folders) and gather metadata
   for every image asset.
2. Download and analyse images only when their Drive `modifiedTime` changes or
   when the AI tagging version is bumped.
3. Augment each asset with:
     • Season + year
     • Orientation, dimensions, primary color palette
     • AI generated tags (3 – 5) and description via OpenAI Vision (if configured)
     • Numeric difficulty score (1 – 5)
     • Camera / lens metadata when available via EXIF
4. Persist the static manifest to public/manifest.json so the frontend can load
   instantly without performing heavy client-side work.

Environment
-----------
GOOGLE_API_KEY           API key with Drive API v3 access.
GOOGLE_DRIVE_FOLDER_ID   Root folder id that contains the portfolio images.
OPENAI_API_KEY           (Optional) Enables GPT-based tagging for best accuracy.

Optional knobs:
DRIVE_PAGE_SIZE          Override pagination size (default 200).
SKIP_AI                  When set to "1", skips AI/image analysis (useful for
                         quick smoke tests).

The script is idempotent and safe to run repeatedly. It keeps a cache by reusing
existing manifest data whenever the Drive `modifiedTime` is unchanged and our
internal AI version stamp matches.
"""

from __future__ import annotations

import io
import json
import logging
import math
import os
import sys
import time
import re
from dataclasses import dataclass, asdict
from datetime import datetime
from pathlib import Path
from textwrap import dedent
from typing import Callable, Dict, Iterable, List, Optional, Tuple

import numpy as np
import requests
from PIL import Image, ImageStat, UnidentifiedImageError
from PIL.ExifTags import TAGS as EXIF_TAGS

# Optional OpenAI client for high-accuracy tagging
try:
    from openai import OpenAI
except Exception:  # pragma: no cover - optional dependency
    OpenAI = None  # type: ignore

# Lazy imports for TensorFlow so we only pay the cost when needed.
try:
    import tensorflow as tf
    from tensorflow.keras.applications.mobilenet_v2 import (
        MobileNetV2,
        decode_predictions,
        preprocess_input,
    )
except Exception:  # pragma: no cover - fallback if TF is not available
    tf = None  # type: ignore
    MobileNetV2 = None  # type: ignore
    decode_predictions = None  # type: ignore
    preprocess_input = None  # type: ignore


# ==== CONSTANTS =============================================================

AI_VERSION = "2025-03-20"  # bump to force reprocessing of all assets
SUPPORTED_EXTENSIONS = {"jpg", "jpeg", "png", "gif", "webp", "bmp"}
DRIVE_API_URL = "https://www.googleapis.com/drive/v3/files"
OUTPUT_PATH = Path("public/manifest.json")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
OPENAI_REQUEST_INTERVAL = float(os.getenv("OPENAI_REQUEST_INTERVAL", "0"))  # seconds between calls
OPENAI_MAX_RETRIES = int(os.getenv("OPENAI_MAX_RETRIES", "5"))
OPENAI_BACKOFF_SECONDS = float(os.getenv("OPENAI_BACKOFF_SECONDS", "20"))
_last_openai_call = 0.0

# Slightly smaller thumbnail than the on-site display to minimise download.
IMAGE_DOWNLOAD_SIZE = "w512"

COLOR_PALETTE = {
    "Red": np.array([214, 69, 69]),
    "Orange": np.array([242, 153, 74]),
    "Yellow": np.array([242, 201, 76]),
    "Green": np.array([39, 174, 96]),
    "Blue": np.array([47, 128, 237]),
    "Purple": np.array([155, 81, 224]),
    "Brown": np.array([141, 110, 99]),
    "Black": np.array([33, 33, 33]),
    "White": np.array([245, 245, 245]),
    "Gray": np.array([189, 189, 189]),
    "Neutral": np.array([149, 165, 166]),
}


# ==== DATA MODELS ===========================================================

@dataclass
class DriveItem:
    id: str
    name: str
    mimeType: str
    createdTime: str
    modifiedTime: str
    webViewLink: str
    parents: List[str]
    size: Optional[str]
    path: str

    @property
    def is_folder(self) -> bool:
        return self.mimeType == "application/vnd.google-apps.folder"

    @property
    def extension(self) -> str:
        return self.name.split(".")[-1].lower()

    @property
    def display_name(self) -> str:
        return ".".join(self.name.split(".")[:-1]) or self.name

    @property
    def image_url(self) -> str:
        return f"https://lh3.googleusercontent.com/d/{self.id}={IMAGE_DOWNLOAD_SIZE}"


@dataclass
class ManifestEntry:
    id: str
    name: str
    path: str
    src: str
    view: str
    createdTime: str
    modifiedTime: str
    mimeType: str
    season: str
    year: int
    tags: List[str]
    difficulty: int
    color: str
    orientation: str
    width: int
    height: int
    camera: str
    lens: str
    dateTime: Optional[str]
    description: str = ""
    aiVersion: str = AI_VERSION


# ==== LOGGING ===============================================================

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("manifest")


# ==== GOOGLE DRIVE HELPERS ==================================================

def list_drive_items(folder_id: str, api_key: str, path: Optional[List[str]] = None) -> List[DriveItem]:
    """
    Recursively list every file in a Drive folder tree.
    """
    collected: List[DriveItem] = []
    stack: List[Tuple[str, List[str]]] = [(folder_id, path or [])]
    page_size = int(os.getenv("DRIVE_PAGE_SIZE", "200"))

    while stack:
        current_folder, current_path = stack.pop()
        page_token = None

        while True:
            params = {
                "q": f"'{current_folder}' in parents and trashed=false",
                "fields": (
                    "nextPageToken,"
                    "files(id,name,mimeType,createdTime,modifiedTime,webViewLink,parents,size)"
                ),
                "key": api_key,
                "pageSize": page_size,
                "orderBy": "name",
                "supportsAllDrives": "true",
                "includeItemsFromAllDrives": "true",
            }
            if page_token:
                params["pageToken"] = page_token

            response = requests.get(DRIVE_API_URL, params=params, timeout=60)
            if response.status_code != 200:
                raise RuntimeError(f"Drive API error {response.status_code}: {response.text}")

            payload = response.json()
            files = payload.get("files", [])

            for raw in files:
                item = DriveItem(
                    id=raw["id"],
                    name=raw["name"],
                    mimeType=raw["mimeType"],
                    createdTime=raw.get("createdTime", ""),
                    modifiedTime=raw.get("modifiedTime", ""),
                    webViewLink=raw.get("webViewLink", ""),
                    parents=raw.get("parents", []),
                    size=raw.get("size"),
                    path="/".join(current_path),
                )
                if item.is_folder:
                    stack.append((item.id, current_path + [item.name]))
                elif item.extension in SUPPORTED_EXTENSIONS:
                    collected.append(item)

            page_token = payload.get("nextPageToken")
            if not page_token:
                break

        # Be nice to the API if the tree is large.
        time.sleep(0.1)

    logger.info("Discovered %s image assets", len(collected))
    return collected


# ==== IMAGE / AI HELPERS ====================================================

def load_existing_manifest() -> Dict[str, dict]:
    if not OUTPUT_PATH.exists():
        return {}
    try:
        data = json.loads(OUTPUT_PATH.read_text())
        return {entry["id"]: entry for entry in data}
    except json.JSONDecodeError:
        logger.warning("Existing manifest is not valid JSON, ignoring cache.")
        return {}


def load_tf_model() -> MobileNetV2:
    if MobileNetV2 is None or tf is None:  # pragma: no cover - runtime guard
        raise RuntimeError(
            "TensorFlow is not available. Install tensorflow-cpu to enable AI tagging."
        )
    logger.info("Loading MobileNetV2 weights (Imagenet)…")
    model = MobileNetV2(weights="imagenet")
    # Warm-up call to avoid first-run latency.
    dummy = np.zeros((1, 224, 224, 3), dtype=np.float32)
    model.predict(dummy)
    logger.info("MobileNetV2 ready.")
    return model


def download_image(url: str) -> Image.Image:
    response = requests.get(url, timeout=60)
    response.raise_for_status()
    try:
        return Image.open(io.BytesIO(response.content)).convert("RGB")
    except UnidentifiedImageError as exc:
        raise RuntimeError(f"Unable to decode image: {url}") from exc


def resize_for_model(img: Image.Image) -> np.ndarray:
    resized = img.copy().resize((224, 224))
    arr = np.asarray(resized, dtype=np.float32)
    arr = np.expand_dims(arr, axis=0)
    return preprocess_input(arr)


def compute_average_rgb(img: Image.Image) -> Tuple[float, float, float]:
    thumb = img.copy().resize((80, 80))
    stat = ImageStat.Stat(thumb)
    r, g, b = stat.mean[:3]
    return float(r), float(g), float(b)


def nearest_palette_color(rgb: Tuple[float, float, float]) -> str:
    vector = np.array(rgb)
    best_name = "Neutral"
    best_distance = math.inf
    for name, swatch in COLOR_PALETTE.items():
        distance = np.linalg.norm(vector - swatch)
        if distance < best_distance:
            best_distance = distance
            best_name = name
    return best_name


def format_tag(tag: str) -> str:
    cleaned = re.sub(r"[\s_/,-]+", " ", str(tag)).strip()
    return " ".join(word.capitalize() for word in cleaned.split() if word)


def deduplicate_tags(tags: Iterable[str]) -> List[str]:
    seen = set()
    ordered: List[str] = []
    for tag in tags:
        formatted = format_tag(tag)
        key = formatted.lower()
        if formatted and key not in seen:
            seen.add(key)
            ordered.append(formatted)
    return ordered


def wait_for_openai(interval: float) -> None:
    """Respect configured rate limits between OpenAI calls."""
    global _last_openai_call
    if interval <= 0:
        return
    elapsed = time.perf_counter() - _last_openai_call
    if elapsed < interval:
        time.sleep(interval - elapsed)
    _last_openai_call = time.perf_counter()


def init_openai_client() -> Optional["OpenAI"]:
    if not OPENAI_API_KEY:
        return None
    if OpenAI is None:
        logger.warning("OPENAI_API_KEY provided but openai package is not installed; skipping GPT tagging.")
        return None
    try:
        return OpenAI(api_key=OPENAI_API_KEY)
    except Exception as exc:  # pragma: no cover - init errors
        logger.warning("Failed to initialise OpenAI client: %s", exc)
        return None


def generate_openai_metadata(client: Optional["OpenAI"], item: DriveItem, image_url: str) -> Optional[dict]:
    if client is None:
        return None

    palette_options = ", ".join(COLOR_PALETTE.keys())
    prompt = dedent(
        f"""
        You label artwork for an online portfolio. Review the provided image and respond with **only** a single JSON object using this schema:
        {{
          "tags": ["Tag 1", "Tag 2", "Tag 3"],
          "difficulty": 3,
          "primary_color": "Blue",
          "description": "A single sentence under 160 characters."
        }}

        Guidance:
        - Tags: 4 or 5 concise subjects (1-3 words each, Title Case), prioritising what painters would search for (e.g., "Starry Sky", "Wine Glasses").
        - Difficulty: integer 1 (very easy) to 5 (most complex) based on the composition and detail.
        - Primary color: choose one of [{palette_options}] representing the dominant palette viewers perceive.
        - Description: one sentence highlighting the subject and vibe.
        - Avoid generic filler like "Painting" or "Art" unless essential; favour meaningful content descriptors.
        - Output **only** the JSON object; do not include markdown fences or commentary.
        """
    ).strip()

    interval = OPENAI_REQUEST_INTERVAL
    data: Optional[dict] = None
    last_error = None
    attempt = 1
    while attempt <= OPENAI_MAX_RETRIES:
        try:
            wait_for_openai(interval)
            response = client.responses.create(
                model="gpt-4o-mini",
                temperature=0.2,
                max_output_tokens=400,
                input=[
                    {
                        "role": "system",
                        "content": "You produce structured metadata that helps customers browse an art portfolio.",
                    },
                    {
                        "role": "user",
                        "content": [
                            {"type": "input_text", "text": prompt},
                            {"type": "input_image", "image_url": image_url},
                        ],
                    },
                ],
            )
            result_text = getattr(response, "output_text", "").strip()
            if not result_text:
                for item_output in getattr(response, "output", []) or []:
                    for block in getattr(item_output, "content", []) or []:
                        block_text = getattr(block, "text", None)
                        if block_text:
                            result_text = block_text.strip()
                            break
                    if result_text:
                        break
            try:
                data = json.loads(result_text)
            except json.JSONDecodeError:
                json_candidates = re.findall(r"\{.*\}", result_text, flags=re.DOTALL)
                data = None
                for candidate in json_candidates:
                    try:
                        data = json.loads(candidate)
                        break
                    except json.JSONDecodeError:
                        continue
                if data is None:
                    raise
            if not isinstance(data, dict):
                raise ValueError("OpenAI response was not a JSON object")
            break
        except Exception as exc:  # pragma: no cover - network/service errors
            last_error = exc
            message = str(exc)
            if "rate_limit" in message or "Limit" in message:
                wait_seconds = OPENAI_BACKOFF_SECONDS
                match = re.search(r"try again in ([0-9.]+)s", message)
                if match:
                    wait_seconds = max(wait_seconds, float(match.group(1)))
                interval = max(interval, wait_seconds)
                logger.warning("[OpenAI] %s (attempt %s/%s) rate limit: %s (sleeping %.2fs)", item.name, attempt, OPENAI_MAX_RETRIES, message, wait_seconds)
                time.sleep(wait_seconds)
                attempt += 1
                continue
            if "TPM" in message or "tokens per min" in message:
                logger.warning("[OpenAI] %s: token cap reached, deferring to fallback. (%s)", item.name, message)
                return None
            logger.warning("[OpenAI] %s (attempt %s/%s): %s", item.name, attempt, OPENAI_MAX_RETRIES, message)
            time.sleep(OPENAI_BACKOFF_SECONDS)
            attempt += 1
            continue
        attempt += 1
    if data is None:
        if last_error:
            logger.warning("[OpenAI] %s: giving up after %s attempts (%s).", item.name, OPENAI_MAX_RETRIES, last_error)
        return None

    if data is None:
        logger.warning("[OpenAI] %s: no data returned after retries.", item.name)
        return None

    raw_tags = data.get("tags") or []
    if isinstance(raw_tags, str):
        raw_tags = [raw_tags]
    tags = deduplicate_tags(raw_tags)[:5]

    try:
        difficulty = int(round(float(data.get("difficulty", 3))))
    except Exception:
        difficulty = 3
    difficulty = max(1, min(5, difficulty))

    raw_color = str(data.get("primary_color", "")).title()
    color = raw_color if raw_color in COLOR_PALETTE else None

    description = str(data.get("description", "")).strip()

    return {
        "tags": tags,
        "difficulty": difficulty,
        "primary_color": color,
        "description": description,
    }


def compute_difficulty_score(tags: List[str], predictions: List[Tuple[str, float]]) -> int:
    if not predictions:
        return 3
    top_conf = predictions[0][1]
    if top_conf >= 0.85:
        score = 1
    elif top_conf >= 0.6:
        score = 2
    elif top_conf >= 0.4:
        score = 3
    elif top_conf >= 0.25:
        score = 4
    else:
        score = 5

    complex_subjects = {
        "Person",
        "People",
        "Crowd",
        "Sports",
        "Action",
        "Vehicle",
        "Car",
        "Night",
        "City",
        "Bird",
        "Dog",
        "Cat",
        "Wildlife",
        "Concert",
        "Water",
        "Wave",
    }
    if any(subject in tags for subject in complex_subjects):
        score = min(5, score + 1)

    low_conf = sum(1 for _, conf in predictions if conf < 0.15)
    if low_conf > len(predictions) / 2:
        score = min(5, score + 1)

    return int(score)


# ==== EXIF HELPERS ==========================================================

EXIF_KEY_MAP = {v: k for k, v in EXIF_TAGS.items()}


def extract_exif_field(exif: dict, field: str) -> Optional[str]:
    key = EXIF_KEY_MAP.get(field)
    if key is None:
        return None
    value = exif.get(key)
    if value is None:
        return None
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8", errors="ignore")
        except Exception:
            return None
    return str(value)


def derive_datetime(exif: dict, fallback: str) -> str:
    for field in ("DateTimeOriginal", "DateTimeDigitized", "DateTime"):
        value = extract_exif_field(exif, field)
        if value:
            return value
    return fallback


def derive_season_and_year(date_str: str) -> Tuple[str, int]:
    try:
        date_obj = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
    except ValueError:
        # Attempt to parse EXIF style strings (e.g., "2021:07:04 12:34:56")
        try:
            date_obj = datetime.strptime(date_str, "%Y:%m:%d %H:%M:%S")
        except Exception:
            date_obj = datetime.utcnow()

    month = date_obj.month
    if 3 <= month <= 5:
        season = "Spring"
    elif 6 <= month <= 8:
        season = "Summer"
    elif 9 <= month <= 11:
        season = "Fall"
    else:
        season = "Winter"
    return season, date_obj.year


# ==== PIPELINE ==============================================================

def build_manifest_entry(
    item: DriveItem,
    model_provider: Optional[Callable[[], Optional[MobileNetV2]]],
    skip_ai: bool,
    openai_client: Optional["OpenAI"],
) -> ManifestEntry:
    logger.info("Processing %s", item.name)
    img = download_image(item.image_url)
    width, height = img.size
    orientation = "Portrait" if height >= width else "Landscape"

    tags: List[str] = []
    difficulty = 3
    predictions: List[Tuple[str, float]] = []

    avg_rgb = compute_average_rgb(img)
    color = nearest_palette_color(avg_rgb)
    description = ""

    if not skip_ai and openai_client:
        metadata = generate_openai_metadata(
            openai_client,
            item,
            f"https://lh3.googleusercontent.com/d/{item.id}=w1200",
        )
        if metadata:
            tags = metadata.get("tags", [])
            difficulty = metadata.get("difficulty", difficulty)
            description = metadata.get("description", "")
            color = metadata.get("primary_color") or color

    if not tags and not skip_ai and model_provider:
        fallback_model = model_provider()
        if fallback_model:
            prepared = resize_for_model(img)
            raw_preds = fallback_model.predict(prepared)
            decoded = decode_predictions(raw_preds, top=5)[0]
            predictions = [(label.replace("_", " ").title(), float(score)) for _, label, score in decoded]
            tags = [label for label, score in predictions if score >= 0.2][:5]
            if len(tags) < 3:
                tags.extend([label for label, _ in predictions if label not in tags])
            tags = tags[:5]
            difficulty = compute_difficulty_score(tags, predictions)

    tags = deduplicate_tags(tags)

    exif_data = img.getexif() or {}
    camera = extract_exif_field(exif_data, "Model") or "Unknown"
    lens = extract_exif_field(exif_data, "LensModel") or "Unknown"
    date_time_str = derive_datetime(exif_data, item.createdTime)
    season, year = derive_season_and_year(date_time_str or item.createdTime)

    extras = [
        season,
        orientation,
        color,
        item.path.split("/")[-1] if item.path else "",
    ]
    for extra in extras:
        if extra:
            tags.append(extra)
    tags = deduplicate_tags(tags)
    if len(tags) < 3:
        for fallback in ("Photography", camera.split(" ")[0], lens.split(" ")[0]):
            if fallback:
                tags.append(fallback)
            tags = deduplicate_tags(tags)
            if len(tags) >= 3:
                break
    tags = tags[:5]

    return ManifestEntry(
        id=item.id,
        name=item.display_name,
        path=item.path,
        src=f"https://lh3.googleusercontent.com/d/{item.id}=w1200",
        view=item.webViewLink,
        createdTime=item.createdTime,
        modifiedTime=item.modifiedTime,
        mimeType=item.mimeType,
        season=season,
        year=year,
        tags=tags[:5],
        difficulty=int(difficulty),
        color=color,
        orientation=orientation,
        width=width,
        height=height,
        camera=camera,
        lens=lens,
        dateTime=date_time_str,
        description=description,
    )


def build_manifest(
    items: Iterable[DriveItem],
    existing: Dict[str, dict],
    skip_ai: bool,
) -> List[ManifestEntry]:
    items = list(items)
    logger.info("Preparing manifest entries (AI %s)", "disabled" if skip_ai else "enabled")

    openai_client = init_openai_client() if not skip_ai else None
    if openai_client:
        logger.info("OpenAI tagging enabled via OPENAI_API_KEY.")

    # Decide if we need TensorFlow (fallback only)
    process_needed = [
        item
        for item in items
        if item.id not in existing
        or existing[item.id].get("modifiedTime") != item.modifiedTime
        or existing[item.id].get("aiVersion") != AI_VERSION
    ]
    logger.info("%s of %s assets require fresh analysis", len(process_needed), len(items))

    max_items = 0
    try:
        max_items = int(os.getenv("MAX_ITEMS_PER_RUN", "0"))
    except ValueError:
        max_items = 0

    deferred_ids: set[str] = set()
    process_ids: Optional[set[str]] = None
    if not skip_ai and max_items > 0 and len(process_needed) > max_items:
        process_ids = {item.id for item in process_needed[:max_items]}
        deferred_ids = {item.id for item in process_needed[max_items:]}
        logger.info(
            "Limiting AI processing to %s images this run (MAX_ITEMS_PER_RUN=%s). Remaining %s will be handled in future runs.",
            len(process_ids),
            max_items,
            len(deferred_ids),
        )
    elif process_needed:
        process_ids = {item.id for item in process_needed}

    model: Optional[MobileNetV2] = None
    model_provider: Optional[Callable[[], Optional[MobileNetV2]]] = None
    if not skip_ai and process_needed:
        def get_tf_model() -> Optional[MobileNetV2]:
            nonlocal model
            if model is None:
                model = load_tf_model()
            return model

        model_provider = get_tf_model

    manifest_entries: List[ManifestEntry] = []
    for item in items:
        cached = existing.get(item.id)
        needs_rebuild = (
            cached is None
            or cached.get("modifiedTime") != item.modifiedTime
            or cached.get("aiVersion") != AI_VERSION
        )
        if needs_rebuild and process_ids is not None and item.id not in process_ids:
            logger.info("Deferring %s (ID %s) to a later run.", item.name, item.id)
            cached_entry = cached if cached else {}
            if cached_entry.get("season") and cached_entry.get("year"):
                season = cached_entry.get("season")
                year = int(cached_entry.get("year"))
            else:
                season, year = derive_season_and_year(item.createdTime or datetime.utcnow().isoformat())
            manifest_entries.append(
                ManifestEntry(
                    id=item.id,
                    name=item.display_name,
                    path=item.path,
                    src=f"https://lh3.googleusercontent.com/d/{item.id}=w1200",
                    view=item.webViewLink,
                    createdTime=item.createdTime,
                    modifiedTime=item.modifiedTime,
                    mimeType=item.mimeType,
                    season=season,
                    year=year,
                    tags=[],
                    difficulty=3,
                    color=cached_entry.get("color", "Neutral"),
                    orientation=cached_entry.get("orientation", "Landscape"),
                    width=int(cached_entry.get("width", 0)),
                    height=int(cached_entry.get("height", 0)),
                    camera=cached_entry.get("camera", "Unknown"),
                    lens=cached_entry.get("lens", "Unknown"),
                    dateTime=cached_entry.get("dateTime"),
                    description="",
                    aiVersion="PENDING",
                )
            )
            continue

        if not needs_rebuild:
            manifest_entries.append(ManifestEntry(**cached))
            continue

        try:
            entry = build_manifest_entry(item, model_provider, skip_ai, openai_client)
            manifest_entries.append(entry)
        except Exception as exc:
            logger.error("Failed to process %s: %s", item.name, exc)
            if cached:
                logger.info("Using cached metadata for %s despite error.", item.name)
                manifest_entries.append(ManifestEntry(**cached))
            else:
                # Minimal entry to keep the image surfaced.
                season, year = derive_season_and_year(item.createdTime or datetime.utcnow().isoformat())
                manifest_entries.append(
                    ManifestEntry(
                        id=item.id,
                        name=item.display_name,
                        path=item.path,
                        src=f"https://lh3.googleusercontent.com/d/{item.id}=w1200",
                        view=item.webViewLink,
                        createdTime=item.createdTime,
                        modifiedTime=item.modifiedTime,
                        mimeType=item.mimeType,
                        season=season,
                        year=year,
                        tags=[],
                        difficulty=3,
                        color="Neutral",
                        orientation="Landscape",
                        width=0,
                        height=0,
                        camera="Unknown",
                        lens="Unknown",
                        dateTime=None,
                        description="",
                    )
                )

    manifest_entries.sort(key=lambda e: (e.year * -1, e.createdTime, e.name))
    return manifest_entries


# ==== MAIN ==================================================================

def main() -> None:
    api_key = os.getenv("GOOGLE_API_KEY")
    folder_id = os.getenv("GOOGLE_DRIVE_FOLDER_ID")

    if not api_key or not folder_id:
        logger.error("GOOGLE_API_KEY and GOOGLE_DRIVE_FOLDER_ID must be set.")
        sys.exit(1)

    skip_ai = os.getenv("SKIP_AI") == "1"

    logger.info("Starting manifest build (AI tagging: %s)", "OFF" if skip_ai else "ON")
    items = list_drive_items(folder_id, api_key)

    existing = load_existing_manifest()
    manifest_entries = build_manifest(items, existing, skip_ai=skip_ai)

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT_PATH.open("w", encoding="utf-8") as fh:
        json.dump([asdict(entry) for entry in manifest_entries], fh, indent=2)

    logger.info("Manifest written to %s", OUTPUT_PATH)
    logger.info("Total entries: %s", len(manifest_entries))
    logger.info("Done.")


if __name__ == "__main__":
    main()
