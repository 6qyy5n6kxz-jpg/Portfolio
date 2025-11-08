/**
 * Photo Gallery App - Main application logic
 * Loads images from Google Drive API v3
 * Consumes pre-built manifest enriched with AI tagging & metadata
 * Manifest is generated server-side via scripts/build_manifest.py
 */

// ==== CONSTANTS & STATE ====
let config = {};
let allItems = [];
let filteredItems = [];
let currentPage = 1;
const CACHE_KEY = 'photo-gallery-manifest-v2';
const CACHE_EXPIRY_HOURS = 24;
const SEASONS = ['Spring', 'Summer', 'Fall', 'Winter'];
const COLOR_SWATCHES = {
    Red: '#D64545',
    Orange: '#F2994A',
    Yellow: '#F2C94C',
    Green: '#27AE60',
    Blue: '#2F80ED',
    Purple: '#9B51E0',
    Brown: '#8D6E63',
    Black: '#333333',
    White: '#FFFFFF',
    Gray: '#BDBDBD',
    Neutral: '#95A5A6'
};
const COLOR_ORDER = Object.keys(COLOR_SWATCHES);
let baseListenersAttached = false;
let filtersToggleInitialized = false;
let filtersToggleBtn = null;
let filtersContainerEl = null;
let dropdownsInitialized = false;
const THEME_STORAGE_KEY = 'gallery-theme';

function getCollectionLabel(path = '') {
    const trimmed = (path || '').trim();
    return trimmed.length > 0 ? trimmed : 'Uncategorized';
}

function resolvePreferredTheme() {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored) return stored;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(theme) {
    const resolved = theme === 'light' ? 'light' : 'dark';
    document.body.classList.toggle('theme-light', resolved === 'light');
    document.body.classList.toggle('theme-dark', resolved === 'dark');
    const toggleBtn = document.getElementById('themeToggleBtn');
    if (toggleBtn) {
        toggleBtn.textContent = resolved === 'light' ? 'Dark mode' : 'Light mode';
        toggleBtn.setAttribute('aria-pressed', resolved === 'light' ? 'true' : 'false');
    }
    localStorage.setItem(THEME_STORAGE_KEY, resolved);
}

function initThemeToggle() {
    applyTheme(resolvePreferredTheme());
    const toggleBtn = document.getElementById('themeToggleBtn');
    if (toggleBtn && !toggleBtn.dataset.bound) {
        toggleBtn.addEventListener('click', () => {
            const nextTheme = document.body.classList.contains('theme-light') ? 'dark' : 'light';
            applyTheme(nextTheme);
        });
        toggleBtn.dataset.bound = 'true';
    }
}

// ==== INITIALIZATION ====
async function init() {
    try {
        showLoading(true);
        config = await loadConfig();
        document.getElementById('galleryTitle').textContent = config.title || 'Photo Gallery';
        const manifest = await loadManifestWithCache();
        allItems = await processImageMetadata(manifest);
        filteredItems = [...allItems];
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
    if (cached && cached.length > 0) {
        console.log('[Manifest] Using cached manifest with', cached.length, 'images');
        return cached;
    }
    if (cached && cached.length === 0) {
        console.log('[Manifest] Cached manifest is empty, fetching fresh...');
        localStorage.removeItem(CACHE_KEY);
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
        console.warn('[Manifest] Could not fetch pre-built manifest', error);
    }
    throw new Error('Manifest unavailable. Ensure the build_manifest workflow has generated public/manifest.json.');
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
// ==== IMAGE METADATA PROCESSING ====
async function processImageMetadata(manifest) {
    return manifest.map((item) => {
        const season = item.season || 'Unknown';
        const year = item.year || new Date().getFullYear();
        return {
            ...item,
            tags: Array.isArray(item.tags) ? [...item.tags] : [],
            season,
            year,
            difficulty: normalizeDifficultyInput(item.difficulty),
            orientation: item.orientation || 'Landscape',
            color: item.color || 'Neutral',
            camera: item.camera || 'Unknown',
            lens: item.lens || 'Unknown',
            description: item.description || '',
            width: item.width || 0,
            height: item.height || 0,
            dateTime: item.dateTime || null
        };
    });
}

function normalizeDifficultyInput(value) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
        return clamp(Math.round(numeric), 1, 5);
    }
    return 3;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function sortColorsForDisplay(colors) {
    return colors.sort((a, b) => {
        const indexA = COLOR_ORDER.indexOf(a);
        const indexB = COLOR_ORDER.indexOf(b);
        if (indexA === -1 && indexB === -1) return a.localeCompare(b);
        if (indexA === -1) return 1;
        if (indexB === -1) return -1;
        return indexA - indexB;
    });
}

// ==== FILTERS & SEARCH ====
function buildFilters(options = {}) {
    const { preserveActive = false } = options;
    const previousFilters = preserveActive ? getActiveFilters() : null;

    renderFilterChips('seasonFilters', SEASONS);
    const difficultyValues = [...new Set(allItems.map(i => i.difficulty))]
        .filter(value => value !== undefined && value !== null)
        .sort((a, b) => a - b)
        .map(String);
    renderFilterChips('difficultyFilters', difficultyValues);
    const orientations = [...new Set(allItems.map(i => i.orientation))].sort();
    renderFilterChips('orientationFilters', orientations);
    const collections = [...new Set(allItems.map(i => getCollectionLabel(i.path)))].sort();
    renderFilterChips('collectionFilters', collections);
    const colors = sortColorsForDisplay([...new Set(allItems.map(i => i.color || 'Neutral'))]);
    renderFilterChips('colorFilters', colors);

    bindFilterChipEvents();

    if (previousFilters) {
        restoreActiveFilterChips(previousFilters);
        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
            searchInput.value = previousFilters.searchRaw || '';
        }
    }

    updateFilterDropdownCounts(getActiveFilters());
    refreshFiltersToggleState();
}

function renderFilterChips(containerId, values) {
    const container = document.getElementById(containerId);
    container.innerHTML = values.map(value => {
        const isColor = containerId === 'colorFilters';
        const colorStyle = isColor ? ` style="--chip-color:${COLOR_SWATCHES[value] || '#888888'}"` : '';
        const classes = `filter-chip${isColor ? ' color-chip' : ''}`;
        return `<div class="${classes}" data-filter="${value}"${colorStyle}>${value}</div>`;
    }).join('');
}

function bindFilterChipEvents() {
    document.querySelectorAll('.filter-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            chip.classList.toggle('active');
            applyFilters();
        });
    });
}

function restoreActiveFilterChips(filters) {
    const mapping = [
        { id: 'seasonFilters', values: filters.season },
        { id: 'difficultyFilters', values: filters.difficulty },
        { id: 'orientationFilters', values: filters.orientation },
        { id: 'collectionFilters', values: filters.collection },
        { id: 'colorFilters', values: filters.color }
    ];
    mapping.forEach(({ id, values }) => {
        const container = document.getElementById(id);
        if (!container || !Array.isArray(values)) return;
        const chips = Array.from(container.querySelectorAll('.filter-chip'));
        values.forEach(value => {
            const chip = chips.find(c => c.dataset.filter === value);
            if (chip) chip.classList.add('active');
        });
    });
}

function updateFilterDropdownCounts(filters) {
    const mapping = [
        { id: 'seasonCount', values: filters.season },
        { id: 'difficultyCount', values: filters.difficulty },
        { id: 'orientationCount', values: filters.orientation },
        { id: 'collectionCount', values: filters.collection },
        { id: 'colorCount', values: filters.color }
    ];
    mapping.forEach(({ id, values }) => {
        const target = document.getElementById(id);
        if (!target) return;
        target.textContent = formatFilterSummary(values);
    });
}

function formatFilterSummary(values = []) {
    if (!values || values.length === 0) return 'All';
    if (values.length === 1) return values[0];
    return `${values.length} selected`;
}

function getActiveFilters() {
    const searchInput = document.getElementById('searchInput');
    const searchValue = searchInput ? searchInput.value : '';
    const filters = {
        season: [],
        difficulty: [],
        orientation: [],
        collection: [],
        color: [],
        search: searchValue.toLowerCase(),
        searchRaw: searchValue
    };
    document.querySelectorAll('.filter-chip.active').forEach(chip => {
        const value = chip.dataset.filter;
        const parent = chip.closest('.filter-chips');
        if (parent?.id === 'seasonFilters') filters.season.push(value);
        else if (parent?.id === 'difficultyFilters') filters.difficulty.push(value);
        else if (parent?.id === 'orientationFilters') filters.orientation.push(value);
        else if (parent?.id === 'collectionFilters') filters.collection.push(value);
        else if (parent?.id === 'colorFilters') filters.color.push(value);
    });
    return filters;
}

function applyFilters(options = {}) {
    const { preservePage = false } = options;
    const previousPage = currentPage;
    const filters = getActiveFilters();
    filteredItems = allItems.filter(item => {
        if (filters.season.length > 0 && !filters.season.includes(item.season)) return false;
        if (filters.difficulty.length > 0 && !filters.difficulty.includes(item.difficulty.toString())) return false;
        if (filters.orientation.length > 0 && !filters.orientation.includes(item.orientation)) return false;
        const collectionLabel = getCollectionLabel(item.path);
        if (filters.collection.length > 0 && !filters.collection.includes(collectionLabel)) return false;
        if (filters.color.length > 0 && !filters.color.includes(item.color)) return false;
        if (filters.search) {
            const searchStr = `${item.name} ${item.tags.join(' ')} ${item.camera} ${item.lens} ${item.path || ''} ${item.description || ''}`.toLowerCase();
            if (!searchStr.includes(filters.search)) return false;
        }
        return true;
    });
    if (preservePage) {
        const itemsPerPage = config.ITEMS_PER_PAGE || 20;
        const totalPages = Math.max(1, Math.ceil(filteredItems.length / itemsPerPage));
        currentPage = Math.min(previousPage, totalPages);
    } else {
        currentPage = 1;
    }
    renderGallery();
    updateFilterDropdownCounts(filters);
    refreshFiltersToggleState(filters);
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
                <div class="gallery-card-meta">${item.path ? `${escapeHtml(item.path)} • ` : ''}${item.season} • Difficulty ${item.difficulty}/5</div>
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
    const totalItems = filteredItems.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / itemsPerPage));
    document.getElementById('prevBtn').disabled = currentPage === 1 || totalItems === 0;
    document.getElementById('nextBtn').disabled = currentPage >= totalPages || totalItems === 0;
    document.getElementById('pageInfo').textContent = totalItems === 0
        ? 'No images to display'
        : `Page ${currentPage} of ${totalPages} (${totalItems} images)`;
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
        ${item.season} • Difficulty ${item.difficulty}/5 • ${item.orientation}<br>
        ${item.path ? `Collection: ${escapeHtml(item.path)}<br>` : ''}
        Color: ${item.color}${item.year ? ` • Year ${item.year}` : ''}<br>
        ${item.description ? `${escapeHtml(item.description)}<br>` : ''}
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
    if (baseListenersAttached) return;
    baseListenersAttached = true;
    initThemeToggle();
    initFiltersToggle();
    initFilterDropdowns();
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('input', () => applyFilters());
    }
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

function initFiltersToggle() {
    if (filtersToggleInitialized) return;
    filtersToggleBtn = document.getElementById('toggleFiltersBtn');
    filtersContainerEl = document.querySelector('.filters-container');
    if (!filtersToggleBtn || !filtersContainerEl) return;

    const update = () => {
        const isMobile = window.matchMedia('(max-width: 768px)').matches;
        if (isMobile) {
            filtersToggleBtn.style.display = 'flex';
            const isOpen = filtersContainerEl.classList.contains('is-open');
            filtersToggleBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        } else {
            filtersToggleBtn.style.display = 'none';
            filtersContainerEl.classList.remove('is-open');
            filtersToggleBtn.setAttribute('aria-expanded', 'true');
            closeAllFilterDropdowns();
        }
        refreshFiltersToggleState();
    };

    filtersToggleBtn.addEventListener('click', () => {
        const isMobile = window.matchMedia('(max-width: 768px)').matches;
        if (!isMobile) return;
        filtersContainerEl.classList.toggle('is-open');
        const isOpen = filtersContainerEl.classList.contains('is-open');
        filtersToggleBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        refreshFiltersToggleState();
    });

    window.addEventListener('resize', update);
    update();
    filtersToggleInitialized = true;
}

function refreshFiltersToggleState(currentFilters = null) {
    if (!filtersToggleBtn) return;
    const filters = currentFilters || getActiveFilters();
    const hasActiveFilters = filters.season.length > 0 ||
        filters.difficulty.length > 0 ||
        filters.orientation.length > 0 ||
        filters.collection.length > 0 ||
        filters.color.length > 0 ||
        (filters.searchRaw?.length || 0) > 0;
    filtersToggleBtn.classList.toggle('has-active', hasActiveFilters);
}

function initFilterDropdowns() {
    if (dropdownsInitialized) return;
    const dropdowns = document.querySelectorAll('.filter-dropdown');
    if (!dropdowns.length) return;

    dropdowns.forEach(dropdown => {
        const trigger = dropdown.querySelector('.filter-dropdown-trigger');
        if (!trigger) return;
        trigger.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const isMobile = window.matchMedia('(max-width: 768px)').matches;
            if (isMobile) {
                dropdown.classList.toggle('open');
            } else {
                const alreadyOpen = dropdown.classList.contains('open');
                closeAllFilterDropdowns();
                if (!alreadyOpen) dropdown.classList.add('open');
            }
        });
    });

    document.addEventListener('click', (event) => {
        if (!event.target.closest('.filter-dropdown')) {
            closeAllFilterDropdowns();
        }
    });
    dropdownsInitialized = true;
}

function closeAllFilterDropdowns() {
    document.querySelectorAll('.filter-dropdown.open').forEach(dropdown => dropdown.classList.remove('open'));
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
