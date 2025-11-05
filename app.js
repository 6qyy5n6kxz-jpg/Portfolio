/**
 * Photo Gallery App - Main application logic
 * Loads images from Google Drive API v3
 * Uses TensorFlow.js mobilenet for on-device ML tagging
 * Extracts EXIF metadata for season/year/camera info
 */

// ==== CONSTANTS & STATE ====
let config = {};
let allItems = [];
let filteredItems = [];
let currentPage = 1;
let model = null;
const CACHE_KEY = 'photo-gallery-manifest';
const CACHE_EXPIRY_HOURS = 24;
const SEASONS = ['Spring', 'Summer', 'Fall', 'Winter'];

// ==== INITIALIZATION ====
async function init() {
    try {
        showLoading(true);
        config = await loadConfig();
        document.getElementById('galleryTitle').textContent = config.title || 'Photo Gallery';
        let manifest = await loadManifestWithCache();
        allItems = await processImageMetadata(manifest);
        if (config.enableMLTagging !== false) {
            await initTensorFlow();
        }
        if (model) {
            allItems = await tagImagesWithAI(allItems);
        }
        buildFilters();
        renderGallery();
        attachEventListeners();
        showLoading(false);
    } catch (error) {
        console.error('[Gallery]', error);
        showError(`Failed to load gallery: ${error.message}`);
        showLoading(false);
    }
}

// ==== CONFIG LOADING ====
async function loadConfig() {
    try {
        const response = await fetch('./public/config.json');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } catch (error) {
        console.error('[Config]', error);
        throw new Error('Configuration file not found. Ensure public/config.json exists.');
    }
}

// ==== MANIFEST MANAGEMENT ====
async function loadManifestWithCache() {
    const cached = getCachedManifest();
    if (cached) {
        console.log('[Manifest] Using cached manifest');
        return cached;
    }
    try {
        const response = await fetch('./public/manifest.json');
        if (response.ok) {
            const manifest = await response.json();
            setCachedManifest(manifest);
            console.log('[Manifest] Loaded from public/manifest.json');
            return manifest;
        }
    } catch (error) {
        console.warn('[Manifest] Could not fetch pre-built manifest');
    }
    console.log('[Manifest] Querying Google Drive API...');
    const manifest = await fetchImagesFromDrive();
    setCachedManifest(manifest);
    return manifest;
}

function getCachedManifest() {
    try {
        const stored = localStorage.getItem(CACHE_KEY);
        if (!stored) return null;
        const { data, timestamp } = JSON.parse(stored);
        const ageHours = (Date.now() - timestamp) / (1000 * 60 * 60);
        if (ageHours > CACHE_EXPIRY_HOURS) {
            localStorage.removeItem(CACHE_KEY);
            return null;
        }
        return data;
    } catch (error) {
        console.warn('[Cache]', error);
        return null;
    }
}

function setCachedManifest(manifest) {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({
            data: manifest,
            timestamp: Date.now()
        }));
    } catch (error) {
        console.warn('[Cache] Failed to cache');
    }
}

// ==== GOOGLE DRIVE API ====
async function fetchImagesFromDrive() {
    if (!config.GOOGLE_DRIVE_FOLDER_ID || !config.GOOGLE_API_KEY) {
        throw new Error('GOOGLE_DRIVE_FOLDER_ID and GOOGLE_API_KEY required in config.json');
    }
    const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];
    const query = `'${config.GOOGLE_DRIVE_FOLDER_ID}' in parents and trashed=false`;
    const fields = 'files(id,name,mimeType,createdTime,modifiedTime,webViewLink)';
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('q', query);
    url.searchParams.set('fields', fields);
    url.searchParams.set('key', config.GOOGLE_API_KEY);
    url.searchParams.set('pageSize', '1000');
    try {
        const response = await fetch(url.toString());
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error?.message || `HTTP ${response.status}`);
        }
        const data = await response.json();
        const imageFiles = (data.files || []).filter(file => {
            const ext = file.name.split('.').pop().toLowerCase();
            return imageExtensions.includes(ext);
        });
        return imageFiles.map(file => ({
            id: file.id,
            name: file.name.replace(/\.[^/.]+$/, ''),
            src: `https://lh3.googleusercontent.com/d/${file.id}=w800`,
            view: file.webViewLink,
            createdTime: file.createdTime,
            modifiedTime: file.modifiedTime
        }));
    } catch (error) {
        console.error('[Drive API]', error);
        throw new Error(`Google Drive API error: ${error.message}`);
    }
}

// ==== IMAGE METADATA PROCESSING ====
async function processImageMetadata(manifest) {
    return Promise.all(manifest.map(async (item) => {
        const exifData = await extractEXIF(item.src);
        const { season, year } = deriveSeasonAndYear(exifData, item);
        return {
            ...item,
            tags: item.tags || [],
            season,
            year,
            difficulty: item.difficulty || 'Medium',
            orientation: exifData.orientation || 'Landscape',
            color: item.color || 'Neutral',
            camera: exifData.camera || 'Unknown',
            lens: exifData.lens || 'Unknown',
            width: exifData.width || 0,
            height: exifData.height || 0,
            dateTime: exifData.dateTime || null
        };
    }));
}

async function extractEXIF(imageSrc) {
    try {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        const dimensionPromise = new Promise((resolve) => {
            img.onload = () => {
                resolve({
                    width: img.naturalWidth,
                    height: img.naturalHeight
                });
            };
            img.onerror = () => resolve({});
            img.src = imageSrc;
        });
        const exifData = await exifr.parse(imageSrc).catch(() => ({}));
        const dimensions = await dimensionPromise;
        const dateTime = exifData.DateTimeOriginal || exifData.DateTime;
        const camera = exifData.Model || '';
        const lens = exifData.LensModel || '';
        const orientation = (exifData.Orientation === 8 || exifData.Orientation === 6)
            ? 'Portrait'
            : 'Landscape';
        return {
            camera: camera.substring(0, 50),
            lens: lens.substring(0, 50),
            dateTime,
            orientation,
            width: dimensions.width || 0,
            height: dimensions.height || 0
        };
    } catch (error) {
        console.warn('[EXIF]', error.message);
        return {};
    }
}

function deriveSeasonAndYear(exifData, item) {
    let date = null;
    if (exifData.dateTime) date = new Date(exifData.dateTime);
    else if (item.createdTime) date = new Date(item.createdTime);
    let year = new Date().getFullYear();
    let season = 'Unknown';
    if (date && !isNaN(date)) {
        year = date.getFullYear();
        const month = date.getMonth();
        if (month >= 2 && month <= 4) season = 'Spring';
        else if (month >= 5 && month <= 7) season = 'Summer';
        else if (month >= 8 && month <= 10) season = 'Fall';
        else season = 'Winter';
    }
    return { season, year };
}

// ==== TENSORFLOW.JS ====
async function initTensorFlow() {
    try {
        console.log('[TensorFlow] Loading mobilenet...');
        model = await mobilenet.load();
        console.log('[TensorFlow] Model loaded');
    } catch (error) {
        console.error('[TensorFlow]', error);
        model = null;
    }
}

async function tagImagesWithAI(items) {
    if (!model) return items;
    return Promise.all(items.map(async (item) => {
        try {
            const predictions = await getImagePredictions(item.src);
            const tags = predictions.slice(0, 3).map(p => p.className);
            const color = classifyColor();
            const difficulty = computeDifficulty(tags, predictions);
            return {
                ...item,
                tags: [...(item.tags || []), ...tags],
                color,
                difficulty
            };
        } catch (error) {
            console.warn(`[AI] ${item.name}:`, error.message);
            return item;
        }
    }));
}

async function getImagePredictions(imageSrc) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = async () => {
            try {
                const predictions = await model.classify(img);
                resolve(predictions);
            } catch (error) {
                reject(error);
            }
        };
        img.onerror = () => reject(new Error('Image load failed'));
        img.src = imageSrc;
    });
}

function classifyColor() {
    const colors = ['Warm', 'Cool', 'Neutral'];
    return colors[Math.floor(Math.random() * colors.length)];
}

function computeDifficulty(tags, predictions) {
    const hardTags = ['person', 'dog', 'cat', 'car', 'action'];
    const hasHardTag = tags.some(tag => 
        hardTags.some(hard => tag.toLowerCase().includes(hard.toLowerCase()))
    );
    if (hasHardTag) return 'Hard';
    const confidence = predictions[0]?.probability || 0;
    return confidence < 0.5 ? 'Medium' : 'Easy';
}

// ==== FILTERS & SEARCH ====
function buildFilters() {
    renderFilterChips('seasonFilters', SEASONS);
    const difficulties = [...new Set(allItems.map(i => i.difficulty))].sort();
    renderFilterChips('difficultyFilters', difficulties);
    const orientations = [...new Set(allItems.map(i => i.orientation))].sort();
    renderFilterChips('orientationFilters', orientations);
    const years = [...new Set(allItems.map(i => i.year))].sort((a, b) => b - a);
    renderFilterChips('yearFilters', years.map(y => y.toString()));
    const colors = [...new Set(allItems.map(i => i.color))].sort();
    renderFilterChips('colorFilters', colors);
}

function renderFilterChips(containerId, values) {
    const container = document.getElementById(containerId);
    container.innerHTML = values.map(value => 
        `<div class="filter-chip" data-filter="${value}">${value}</div>`
    ).join('');
}

function getActiveFilters() {
    const filters = {
        season: [],
        difficulty: [],
        orientation: [],
        year: [],
        color: [],
        search: document.getElementById('searchInput').value.toLowerCase()
    };
    document.querySelectorAll('.filter-chip.active').forEach(chip => {
        const value = chip.dataset.filter;
        const parent = chip.closest('.filter-chips');
        if (parent?.id === 'seasonFilters') filters.season.push(value);
        else if (parent?.id === 'difficultyFilters') filters.difficulty.push(value);
        else if (parent?.id === 'orientationFilters') filters.orientation.push(value);
        else if (parent?.id === 'yearFilters') filters.year.push(value);
        else if (parent?.id === 'colorFilters') filters.color.push(value);
    });
    return filters;
}

function applyFilters() {
    const filters = getActiveFilters();
    filteredItems = allItems.filter(item => {
        if (filters.season.length > 0 && !filters.season.includes(item.season)) return false;
        if (filters.difficulty.length > 0 && !filters.difficulty.includes(item.difficulty)) return false;
        if (filters.orientation.length > 0 && !filters.orientation.includes(item.orientation)) return false;
        if (filters.year.length > 0 && !filters.year.includes(item.year.toString())) return false;
        if (filters.color.length > 0 && !filters.color.includes(item.color)) return false;
        if (filters.search) {
            const searchStr = `${item.name} ${item.tags.join(' ')} ${item.camera} ${item.lens}`.toLowerCase();
            if (!searchStr.includes(filters.search)) return false;
        }
        return true;
    });
    currentPage = 1;
    renderGallery();
}

// ==== GALLERY RENDERING ====
function renderGallery() {
    const grid = document.getElementById('galleryGrid');
    const itemsPerPage = config.ITEMS_PER_PAGE || 20;
    const start = (currentPage - 1) * itemsPerPage;
    const end = start + itemsPerPage;
    const pageItems = filteredItems.slice(start, end);
    if (pageItems.length === 0) {
        grid.innerHTML = '<div class="empty-state"><h2>No images found</h2><p>Try adjusting your filters or search</p></div>';
        updatePagination();
        return;
    }
    grid.innerHTML = pageItems.map(item => `
        <div class="gallery-card" data-id="${item.id}">
            <img class="gallery-card-image" 
                 src="${item.src}" 
                 alt="${item.name}"
                 loading="lazy"
                 onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22200%22%3E%3Crect fill=%22%23333%22 width=%22200%22 height=%22200%22/%3E%3C/svg%3E'">
            <div class="gallery-card-content">
                <div class="gallery-card-title">${escapeHtml(item.name)}</div>
                <div class="gallery-card-meta">${item.year} • ${item.season}</div>
                <div class="gallery-card-tags">
                    ${item.tags.map((tag, idx) => 
                        `<span class="tag ${idx >= (item.tags.length - 3) ? 'ai-tag' : ''}">${escapeHtml(tag)}</span>`
                    ).join('')}
                </div>
            </div>
        </div>
    `).join('');
    grid.querySelectorAll('.gallery-card').forEach(card => {
        card.addEventListener('click', () => openModal(card.dataset.id));
    });
    updatePagination();
}

function updatePagination() {
    const itemsPerPage = config.ITEMS_PER_PAGE || 20;
    const totalPages = Math.ceil(filteredItems.length / itemsPerPage);
    document.getElementById('prevBtn').disabled = currentPage === 1;
    document.getElementById('nextBtn').disabled = currentPage >= totalPages;
    document.getElementById('pageInfo').textContent = 
        `Page ${currentPage} of ${totalPages} (${filteredItems.length} images)`;
}

// ==== MODAL / LIGHTBOX ====
function openModal(itemId) {
    const item = filteredItems.find(i => i.id === itemId);
    if (!item) return;
    const modal = document.getElementById('imageModal');
    const img = document.getElementById('modalImage');
    const info = document.getElementById('modalInfo');
    img.src = item.src;
    img.alt = item.name;
    info.innerHTML = `
        <strong>${escapeHtml(item.name)}</strong><br>
        ${item.year} • ${item.season} • ${item.orientation}<br>
        ${item.camera} ${item.lens}<br>
        ${item.tags.map(tag => `<span class="tag ai-tag">${escapeHtml(tag)}</span>`).join('')}
        <br><a href="${item.view}" target="_blank" rel="noopener">View in Drive →</a>
    `;
    modal.classList.add('show');
}

function closeModal() {
    document.getElementById('imageModal').classList.remove('show');
}

// ==== EVENT LISTENERS ====
function attachEventListeners() {
    document.getElementById('searchInput').addEventListener('input', applyFilters);
    document.querySelectorAll('.filter-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            chip.classList.toggle('active');
            applyFilters();
        });
    });
    document.getElementById('clearFiltersBtn').addEventListener('click', () => {
        document.querySelectorAll('.filter-chip.active').forEach(chip => {
            chip.classList.remove('active');
        });
        document.getElementById('searchInput').value = '';
        applyFilters();
    });
    document.getElementById('prevBtn').addEventListener('click', () => {
        if (currentPage > 1) {
            currentPage--;
            renderGallery();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
    });
    document.getElementById('nextBtn').addEventListener('click', () => {
        const itemsPerPage = config.ITEMS_PER_PAGE || 20;
        const totalPages = Math.ceil(filteredItems.length / itemsPerPage);
        if (currentPage < totalPages) {
            currentPage++;
            renderGallery();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
    });
    document.querySelector('.modal-close').addEventListener('click', closeModal);
    document.getElementById('imageModal').addEventListener('click', (e) => {
        if (e.target.id === 'imageModal') closeModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeModal();
    });
}

// ==== UTILITIES ====
function showLoading(show) {
    document.getElementById('loadingIndicator').style.display = show ? 'flex' : 'none';
}

function showError(message) {
    const errorEl = document.getElementById('errorMessage');
    errorEl.textContent = message;
    errorEl.classList.add('show');
    setTimeout(() => errorEl.classList.remove('show'), 5000);
}

function escapeHtml(text) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return text.replace(/[&<>"']/g, m => map[m]);
}

// ==== START ====
init();
