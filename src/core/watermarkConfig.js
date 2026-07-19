import { computeRegionSpatialCorrelation } from './adaptiveDetector.js';

/**
 * Detect watermark configuration based on image size
 * @param {number} imageWidth - Image width
 * @param {number} imageHeight - Image height
 * @returns {Object} Watermark configuration {logoSize, marginRight, marginBottom}
 */
export function detectWatermarkConfig(imageWidth, imageHeight) {
    // Gemini's historical default rules:
    // If both image width and height are greater than 1024, use 96×96 watermark
    // Otherwise, use 48×48 watermark
    if (imageWidth > 1024 && imageHeight > 1024) {
        return {
            logoSize: 96,
            marginRight: 64,
            marginBottom: 64
        };
    }

    return {
        logoSize: 48,
        marginRight: 32,
        marginBottom: 32
    };
}

/**
 * Calculate watermark position in image based on image size and watermark configuration
 * @param {number} imageWidth - Image width
 * @param {number} imageHeight - Image height
 * @param {Object} config - Watermark configuration {logoSize, marginRight, marginBottom}
 * @returns {Object} Watermark position {x, y, width, height}
 */
export function calculateWatermarkPosition(imageWidth, imageHeight, config) {
    const { logoSize, marginRight, marginBottom } = config;

    return {
        x: imageWidth - marginRight - logoSize,
        y: imageHeight - marginBottom - logoSize,
        width: logoSize,
        height: logoSize
    };
}

function getStandardConfig(size) {
    return size === 96
        ? { logoSize: 96, marginRight: 64, marginBottom: 64 }
        : { logoSize: 48, marginRight: 32, marginBottom: 32 };
}

function getAlphaMapForConfig(config, alpha48, alpha96) {
    return config.logoSize === 96 ? alpha96 : alpha48;
}

function isRegionInsideImage(imageData, region) {
    return region.x >= 0 &&
        region.y >= 0 &&
        region.x + region.width <= imageData.width &&
        region.y + region.height <= imageData.height;
}

/**
 * Search best position for a given config by sampling positions around the default.
 * Returns { x, y, width, height, score } for best candidate.
 */
function searchBestPositionAround({ imageData, basePosition, sampleWidth, alphaMap, maxOffset = 48, step = 8 }) {
    let best = { score: -Infinity, x: basePosition.x, y: basePosition.y, width: sampleWidth, height: sampleWidth };

    // compute a small grid of offsets; keep samples bounded to avoid explosion
    const halfRange = Math.min(maxOffset, Math.round(sampleWidth * 1.5));
    const stepPx = Math.max(4, Math.round(step));

    for (let dy = -halfRange; dy <= halfRange; dy += stepPx) {
        for (let dx = -halfRange; dx <= halfRange; dx += stepPx) {
            const x = basePosition.x + dx;
            const y = basePosition.y + dy;

            if (!isRegionInsideImage(imageData, { x, y, width: sampleWidth, height: sampleWidth })) continue;

            const score = computeRegionSpatialCorrelation({
                imageData,
                alphaMap,
                region: { x, y, size: sampleWidth }
            });

            if (score > best.score) {
                best = { score, x, y, width: sampleWidth, height: sampleWidth };
            }
        }
    }

    return best;
}

/**
 * Adaptive detection: choose between 48/96 standard configs and find the best position
 * around the standard estimate. Returns { config, position, score, source }.
 */
export function detectBestConfigAndPosition({
    imageData,
    defaultConfig,
    alpha48,
    alpha96,
    // tuning params:
    maxOffset = 48,
    step = 8,
    minScoreToAccept = 0.18,
    minScoreDelta = 0.08
} = {}) {
    if (!imageData || !defaultConfig || !alpha48 || !alpha96) {
        // fallback to default config and its standard position
        const fallbackPos = calculateWatermarkPosition(imageData?.width || 0, imageData?.height || 0, defaultConfig || getStandardConfig(48));
        return { config: defaultConfig || getStandardConfig(48), position: fallbackPos, score: 0, source: 'fallback' };
    }

    const configs = [getStandardConfig(48), getStandardConfig(96)];
    // ensure the defaultConfig is tested first (performance)
    configs.sort((a, b) => (a.logoSize === defaultConfig.logoSize ? -1 : 0));

    let bestOverall = null;

    for (const cfg of configs) {
        const basePos = calculateWatermarkPosition(imageData.width, imageData.height, cfg);
        if (!isRegionInsideImage(imageData, basePos)) continue;

        const alphaMap = getAlphaMapForConfig(cfg, alpha48, alpha96);

        // base score at the canonical position
        const baseScore = computeRegionSpatialCorrelation({
            imageData,
            alphaMap,
            region: { x: basePos.x, y: basePos.y, size: basePos.width }
        });

        // update bestOverall if this is better
        if (!bestOverall || baseScore > bestOverall.score) {
            bestOverall = {
                config: cfg,
                position: { x: basePos.x, y: basePos.y, width: basePos.width, height: basePos.height },
                score: baseScore,
                source: 'standard'
            };
        }

        // Only search nearby if baseScore is below threshold (i.e., possible displacement)
        if (baseScore < minScoreToAccept) {
            const bestLocal = searchBestPositionAround({
                imageData,
                basePosition: basePos,
                sampleWidth: basePos.width,
                alphaMap,
                maxOffset,
                step
            });

            if (bestLocal.score > (bestOverall?.score ?? -Infinity) + minScoreDelta) {
                bestOverall = {
                    config: cfg,
                    position: { x: bestLocal.x, y: bestLocal.y, width: bestLocal.width, height: bestLocal.height },
                    score: bestLocal.score,
                    source: 'adaptive'
                };
            }
        }
    }

    // If we found nothing valid, fall back to default
    if (!bestOverall) {
        const fallbackPos = calculateWatermarkPosition(imageData.width, imageData.height, defaultConfig);
        return { config: defaultConfig, position: fallbackPos, score: 0, source: 'fallback' };
    }

    return bestOverall;
}

/**
 * Resolve initial standard config by comparing 48/96 template correlation scores.
 * This helps when fixed size rules mismatch newer Gemini output layouts.
 *
 * (Deprecated in favor of detectBestConfigAndPosition, kept for compatibility)
 */
export function resolveInitialStandardConfig({
    imageData,
    defaultConfig,
    alpha48,
    alpha96,
    minSwitchScore = 0.25,
    minScoreDelta = 0.08
}) {
    // Keep previous, simpler behavior to preserve backwards compatibility.
    if (!imageData || !defaultConfig || !alpha48 || !alpha96) return defaultConfig;

    const fallbackConfig = getStandardConfig(48);
    const primaryConfig = defaultConfig.logoSize === 96 ? getStandardConfig(96) : fallbackConfig;
    const alternateConfig = defaultConfig.logoSize === 96 ? fallbackConfig : getStandardConfig(96);

    const primaryRegion = calculateWatermarkPosition(imageData.width, imageData.height, primaryConfig);
    const alternateRegion = calculateWatermarkPosition(imageData.width, imageData.height, alternateConfig);

    if (!isRegionInsideImage(imageData, primaryRegion)) return defaultConfig;

    const primaryScore = computeRegionSpatialCorrelation({
        imageData,
        alphaMap: getAlphaMapForConfig(primaryConfig, alpha48, alpha96),
        region: {
            x: primaryRegion.x,
            y: primaryRegion.y,
            size: primaryRegion.width
        }
    });

    if (!isRegionInsideImage(imageData, alternateRegion)) return primaryConfig;

    const alternateScore = computeRegionSpatialCorrelation({
        imageData,
        alphaMap: getAlphaMapForConfig(alternateConfig, alpha48, alpha96),
        region: {
            x: alternateRegion.x,
            y: alternateRegion.y,
            size: alternateRegion.width
        }
    });

    const shouldSwitch =
        alternateScore >= minSwitchScore &&
        alternateScore > primaryScore + minScoreDelta;

    return shouldSwitch ? alternateConfig : primaryConfig;
}
