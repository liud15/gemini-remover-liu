import exifr from 'exifr';
import i18n from './i18n.js';

const GEMINI_LEGACY_DIMENSIONS = Object.freeze([
    [1024, 1024],
    [832, 1248],
    [1248, 832],
    [864, 1184],
    [1184, 864],
    [896, 1152],
    [1152, 896],
    [768, 1344],
    [1344, 768],
    [1536, 672]
]);

const GEMINI_ASPECT_RATIOS = Object.freeze([
    1 / 1,
    1 / 4,
    1 / 8,
    2 / 3,
    3 / 2,
    3 / 4,
    4 / 1,
    4 / 3,
    4 / 5,
    5 / 4,
    8 / 1,
    9 / 16,
    16 / 9,
    21 / 9
]);

const GEMINI_AREA_TIERS = Object.freeze([1024 * 1024, 2048 * 2048, 4096 * 4096]);
const GEMINI_STEP = 16;
const GEMINI_DIMENSION_OFFSETS = Object.freeze([-32, -16, 0, 16, 32]);

function normalizeDimension(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    const rounded = Math.round(numeric);
    return rounded > 0 ? rounded : null;
}

function normalizeScore(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function addDimensionPair(set, width, height) {
    if (width <= 0 || height <= 0) return;
    if (width % GEMINI_STEP !== 0 || height % GEMINI_STEP !== 0) return;
    set.add(`${width}x${height}`);
}

function buildLikelyGeminiDimensionSet() {
    const set = new Set();
    for (const [width, height] of GEMINI_LEGACY_DIMENSIONS) {
        addDimensionPair(set, width, height);
    }

    for (const aspect of GEMINI_ASPECT_RATIOS) {
        for (const area of GEMINI_AREA_TIERS) {
            const idealWidth = Math.sqrt(area * aspect);
            const idealHeight = Math.sqrt(area / aspect);
            const baseWidth = Math.round(idealWidth / GEMINI_STEP) * GEMINI_STEP;
            const baseHeight = Math.round(idealHeight / GEMINI_STEP) * GEMINI_STEP;

            for (const dw of GEMINI_DIMENSION_OFFSETS) {
                for (const dh of GEMINI_DIMENSION_OFFSETS) {
                    const width = baseWidth + dw;
                    const height = baseHeight + dh;
                    if (width <= 0 || height <= 0) continue;

                    const ratioError = Math.abs(width / height - aspect) / aspect;
                    if (ratioError > 0.04) continue;

                    const areaError = Math.abs(width * height - area) / area;
                    if (areaError > 0.12) continue;

                    addDimensionPair(set, width, height);
                }
            }
        }
    }

    return set;
}

const LIKELY_GEMINI_DIMENSIONS = buildLikelyGeminiDimensionSet();

export function isLikelyGeminiDimensions(width, height) {
    const normalizedWidth = normalizeDimension(width);
    const normalizedHeight = normalizeDimension(height);
    if (!normalizedWidth || !normalizedHeight) return false;
    return LIKELY_GEMINI_DIMENSIONS.has(`${normalizedWidth}x${normalizedHeight}`);
}

function extractImageDimensions(exif) {
    const width =
        normalizeDimension(exif?.ImageWidth) ??
        normalizeDimension(exif?.ExifImageWidth) ??
        normalizeDimension(exif?.PixelXDimension);
    const height =
        normalizeDimension(exif?.ImageHeight) ??
        normalizeDimension(exif?.ExifImageHeight) ??
        normalizeDimension(exif?.PixelYDimension);
    return { width, height };
}

export function evaluateOriginalFromExif(exif) {
    const { width, height } = extractImageDimensions(exif);
    const isOriginal = Boolean(width && height);

    const credit = typeof exif?.Credit === 'string' ? exif.Credit.trim() : '';
    const isGoogleByCredit = credit.toLowerCase() === 'made with google ai';

    // Fallback for metadata-stripped exports: accept known Gemini output dimensions.
    const isGoogleByDimension = isOriginal && isLikelyGeminiDimensions(width, height);

    return {
        is_google: isGoogleByCredit || isGoogleByDimension,
        is_original: isOriginal
    };
}

export function loadImage(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = e.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

export async function checkOriginal(file) {
    try {
        const exif = await exifr.parse(file, { xmp: true });
        return evaluateOriginalFromExif(exif);
    } catch {
        return { is_google: false, is_original: false };
    }
}

export function isLikelyGeminiByWatermarkMeta(
    watermarkMeta,
    {
        minSpatialScore = 0.22,
        maxResidualScore = 0.2,
        minSuppressionGain = 0.25,
        minAdaptiveConfidence = 0.35,
        minAdaptiveSuppressionGain = 0.16,
        minSize = 24,
        maxSize = 192
    } = {}
) {
    if (!watermarkMeta || typeof watermarkMeta !== 'object') return false;

    const size = normalizeDimension(watermarkMeta.size);
    if (!size || size < minSize || size > maxSize) return false;

    const position = watermarkMeta.position;
    const positionWidth = normalizeDimension(position?.width);
    const positionHeight = normalizeDimension(position?.height);
    if (!positionWidth || !positionHeight) return false;

    const detection = watermarkMeta.detection || {};
    const adaptiveConfidence = normalizeScore(detection.adaptiveConfidence);
    const originalSpatialScore = normalizeScore(detection.originalSpatialScore);
    const processedSpatialScore = normalizeScore(detection.processedSpatialScore);
    const suppressionGain = normalizeScore(detection.suppressionGain);

    if (
        adaptiveConfidence !== null &&
        adaptiveConfidence >= minAdaptiveConfidence &&
        suppressionGain !== null &&
        suppressionGain >= minAdaptiveSuppressionGain
    ) {
        return true;
    }

    return (
        originalSpatialScore !== null &&
        processedSpatialScore !== null &&
        suppressionGain !== null &&
        originalSpatialScore >= minSpatialScore &&
        processedSpatialScore <= maxResidualScore &&
        suppressionGain >= minSuppressionGain
    );
}

export function resolveOriginalValidation(validation, watermarkMeta) {
    const normalized = {
        is_google: Boolean(validation?.is_google),
        is_original: Boolean(validation?.is_original)
    };

    if (normalized.is_google) return normalized;
    if (!isLikelyGeminiByWatermarkMeta(watermarkMeta)) return normalized;

    return {
        ...normalized,
        is_google: true
    };
}

export function getOriginalStatus({ is_google, is_original }) {
    if (!is_google) return i18n.t('original.not_gemini');
    return i18n.t('original.pass');
}

const statusMessage = typeof document !== 'undefined'
    ? document.getElementById('statusMessage')
    : null;
export function setStatusMessage(message = '', type = '') {
    if (!statusMessage) return;
    statusMessage.textContent = message;
    statusMessage.style.display = message ? 'block' : 'none';
    const colorMap = { warn: 'text-warn', success: 'text-success' };
    statusMessage.classList.remove(...Object.values(colorMap));
    if (colorMap[type]) statusMessage.classList.add(colorMap[type]);
}

const loadingOverlay = typeof document !== 'undefined'
    ? document.getElementById('loadingOverlay')
    : null;
export function showLoading(text = null) {
    if (!loadingOverlay) return;
    loadingOverlay.style.display = 'flex';
    const textEl = loadingOverlay.querySelector('p');
    if (textEl && text) textEl.textContent = text;
}

export function hideLoading() {
    if (!loadingOverlay) return;
    loadingOverlay.style.display = 'none';
}
