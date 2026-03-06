import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';

import { chromium } from 'playwright';

import { calculateAlphaMap } from '../../src/core/alphaMap.js';
import { removeWatermark } from '../../src/core/blendModes.js';
import {
    computeRegionSpatialCorrelation,
    computeRegionGradientCorrelation,
    detectAdaptiveWatermarkRegion,
    interpolateAlphaMap,
    warpAlphaMap,
    shouldAttemptAdaptiveFallback
} from '../../src/core/adaptiveDetector.js';
import {
    calculateWatermarkPosition,
    detectWatermarkConfig,
    resolveInitialStandardConfig
} from '../../src/core/watermarkConfig.js';

const ROOT_DIR = process.cwd();
const SAMPLE_DIR = path.resolve(ROOT_DIR, 'src/assets/samples');
const BG48_PATH = path.resolve(ROOT_DIR, 'src/assets/bg_48.png');
const BG96_PATH = path.resolve(ROOT_DIR, 'src/assets/bg_96.png');
const IMAGE_EXTENSIONS = new Set(['.png', '.webp', '.jpg', '.jpeg']);
const RESIDUAL_RECALIBRATION_THRESHOLD = 0.5;
const MIN_SUPPRESSION_FOR_SKIP_RECALIBRATION = 0.18;
const MIN_RECALIBRATION_SCORE_DELTA = 0.18;
const OUTLINE_REFINEMENT_THRESHOLD = 0.42;
const OUTLINE_REFINEMENT_MIN_GAIN = 1.2;
const ALPHA_GAIN_CANDIDATES = (() => {
    const candidates = [];

    for (let gain = 1.15; gain <= 1.65; gain += 0.01) {
        candidates.push(Number(gain.toFixed(2)));
    }

    for (let gain = 1.7; gain <= 2.6; gain += 0.1) {
        candidates.push(Number(gain.toFixed(2)));
    }

    return candidates;
})();
const NEAR_BLACK_THRESHOLD = 5;
const MAX_NEAR_BLACK_RATIO_INCREASE = 0.05;
const SUBPIXEL_SHIFTS = [-0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75];
const SUBPIXEL_SCALES = [0.98, 0.99, 1, 1.01, 1.02];

test('isMissingPlaywrightExecutableError should detect missing-browser launch error', () => {
    const error = new Error(
        'browserType.launch: Executable doesn\'t exist at /tmp/playwright/chrome-headless-shell'
    );
    assert.equal(isMissingPlaywrightExecutableError(error), true);
});

test('isMissingPlaywrightExecutableError should ignore unrelated errors', () => {
    const error = new Error('network timeout');
    assert.equal(isMissingPlaywrightExecutableError(error), false);
});

function isMissingPlaywrightExecutableError(error) {
    const message = typeof error?.message === 'string'
        ? error.message
        : String(error ?? '');
    return message.includes('Executable doesn\'t exist') ||
        message.includes('Executable does not exist') ||
        message.includes('download new browsers');
}

function cloneImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

function inferMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.webp') return 'image/webp';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    return 'image/png';
}

async function decodeImageDataInPage(page, filePath) {
    const buffer = await readFile(filePath);
    const mime = inferMimeType(filePath);
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;

    const output = await page.evaluate(async (imageUrl) => {
        const img = new Image();
        img.src = imageUrl;
        await img.decode();

        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;

        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        return {
            width: imageData.width,
            height: imageData.height,
            data: imageData.data
        };
    }, dataUrl);

    return {
        width: output.width,
        height: output.height,
        data: new Uint8ClampedArray(output.data)
    };
}

function shouldRecalibrateAlphaStrength({ originalScore, processedScore, suppressionGain }) {
    return originalScore >= 0.6 &&
        processedScore >= RESIDUAL_RECALIBRATION_THRESHOLD &&
        suppressionGain <= MIN_SUPPRESSION_FOR_SKIP_RECALIBRATION;
}

function recalibrateAlphaStrength({
    originalImageData,
    alphaMap,
    position,
    originalSpatialScore,
    processedSpatialScore,
    originalNearBlackRatio
}) {
    let bestScore = processedSpatialScore;
    let bestGain = 1;
    let bestImageData = null;
    const maxAllowedNearBlackRatio = Math.min(1, originalNearBlackRatio + MAX_NEAR_BLACK_RATIO_INCREASE);

    for (const alphaGain of ALPHA_GAIN_CANDIDATES) {
        const candidate = cloneImageData(originalImageData);
        removeWatermark(candidate, alphaMap, position, { alphaGain });
        const candidateNearBlackRatio = calculateNearBlackRatio(candidate, position);
        if (candidateNearBlackRatio > maxAllowedNearBlackRatio) {
            continue;
        }

        const score = computeRegionSpatialCorrelation({
            imageData: candidate,
            alphaMap,
            region: {
                x: position.x,
                y: position.y,
                size: position.width
            }
        });

        if (score < bestScore) {
            bestScore = score;
            bestGain = alphaGain;
            bestImageData = candidate;
        }
    }

    const scoreDelta = processedSpatialScore - bestScore;
    if (!bestImageData || scoreDelta < MIN_RECALIBRATION_SCORE_DELTA) {
        return null;
    }

    return {
        imageData: bestImageData,
        alphaGain: bestGain,
        processedSpatialScore: bestScore,
        suppressionGain: originalSpatialScore - bestScore
    };
}

function calculateNearBlackRatio(imageData, position) {
    let nearBlack = 0;
    let total = 0;
    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const idx = ((position.y + row) * imageData.width + (position.x + col)) * 4;
            const r = imageData.data[idx];
            const g = imageData.data[idx + 1];
            const b = imageData.data[idx + 2];
            if (r <= NEAR_BLACK_THRESHOLD && g <= NEAR_BLACK_THRESHOLD && b <= NEAR_BLACK_THRESHOLD) {
                nearBlack++;
            }
            total++;
        }
    }

    return total > 0 ? nearBlack / total : 0;
}

function refineSubpixelOutline({
    originalImageData,
    alphaMap,
    position,
    alphaGain,
    originalNearBlackRatio,
    baselineSpatialScore,
    baselineGradientScore
}) {
    const size = position.width;
    if (!size || size <= 8) return null;
    if (alphaGain < OUTLINE_REFINEMENT_MIN_GAIN) return null;

    const maxAllowedNearBlackRatio = Math.min(1, originalNearBlackRatio + MAX_NEAR_BLACK_RATIO_INCREASE);
    const gainCandidates = [alphaGain];
    const lower = Math.max(1, Number((alphaGain - 0.02).toFixed(2)));
    const upper = Number((alphaGain + 0.02).toFixed(2));
    if (lower !== alphaGain) gainCandidates.push(lower);
    if (upper !== alphaGain) gainCandidates.push(upper);

    let best = null;
    for (const scale of SUBPIXEL_SCALES) {
        for (const dy of SUBPIXEL_SHIFTS) {
            for (const dx of SUBPIXEL_SHIFTS) {
                const warped = warpAlphaMap(alphaMap, size, { dx, dy, scale });
                for (const gain of gainCandidates) {
                    const candidate = cloneImageData(originalImageData);
                    removeWatermark(candidate, warped, position, { alphaGain: gain });
                    const nearBlackRatio = calculateNearBlackRatio(candidate, position);
                    if (nearBlackRatio > maxAllowedNearBlackRatio) continue;

                    const spatialScore = computeRegionSpatialCorrelation({
                        imageData: candidate,
                        alphaMap: warped,
                        region: { x: position.x, y: position.y, size }
                    });
                    const gradientScore = computeRegionGradientCorrelation({
                        imageData: candidate,
                        alphaMap: warped,
                        region: { x: position.x, y: position.y, size }
                    });

                    const cost = Math.abs(spatialScore) * 0.6 + Math.max(0, gradientScore);
                    if (!best || cost < best.cost) {
                        best = {
                            imageData: candidate,
                            alphaMap: warped,
                            alphaGain: gain,
                            spatialScore,
                            gradientScore,
                            cost
                        };
                    }
                }
            }
        }
    }

    if (!best) return null;

    const improvedGradient = best.gradientScore <= baselineGradientScore - 0.04;
    const keptSpatial = Math.abs(best.spatialScore) <= Math.abs(baselineSpatialScore) + 0.08;
    if (!improvedGradient || !keptSpatial) return null;

    return best;
}

function removeWatermarkLikeEngine(imageData, alpha48, alpha96) {
    const defaultConfig = detectWatermarkConfig(imageData.width, imageData.height);
    const resolvedConfig = resolveInitialStandardConfig({
        imageData,
        defaultConfig,
        alpha48,
        alpha96
    });

    let config = resolvedConfig;
    let position = calculateWatermarkPosition(imageData.width, imageData.height, config);
    let alphaMap = config.logoSize === 96 ? alpha96 : alpha48;

    const fixed = cloneImageData(imageData);
    removeWatermark(fixed, alphaMap, position);
    let finalImageData = fixed;

    const shouldFallback = shouldAttemptAdaptiveFallback({
        processedImageData: fixed,
        alphaMap,
        position,
        originalImageData: imageData,
        originalSpatialMismatchThreshold: 0
    });

    if (shouldFallback) {
        const adaptive = detectAdaptiveWatermarkRegion({
            imageData,
            alpha96,
            defaultConfig: config
        });

        if (adaptive.found) {
            const size = adaptive.region.size;
            const adaptivePosition = {
                x: adaptive.region.x,
                y: adaptive.region.y,
                width: size,
                height: size
            };
            const positionDelta =
                Math.abs(adaptivePosition.x - position.x) +
                Math.abs(adaptivePosition.y - position.y) +
                Math.abs(adaptivePosition.width - position.width);

            if (positionDelta >= 4) {
                position = adaptivePosition;
                alphaMap = size === 96 ? alpha96 : interpolateAlphaMap(alpha96, 96, size);
                finalImageData = cloneImageData(imageData);
                removeWatermark(finalImageData, alphaMap, position);
            }
        }
    }

    const beforeScore = computeRegionSpatialCorrelation({
        imageData,
        alphaMap,
        region: {
            x: position.x,
            y: position.y,
            size: position.width
        }
    });
    const beforeGradient = computeRegionGradientCorrelation({
        imageData,
        alphaMap,
        region: {
            x: position.x,
            y: position.y,
            size: position.width
        }
    });

    let afterScore = computeRegionSpatialCorrelation({
        imageData: finalImageData,
        alphaMap,
        region: {
            x: position.x,
            y: position.y,
            size: position.width
        }
    });
    let afterGradient = computeRegionGradientCorrelation({
        imageData: finalImageData,
        alphaMap,
        region: {
            x: position.x,
            y: position.y,
            size: position.width
        }
    });
    let improvement = beforeScore - afterScore;
    let alphaGain = 1;

    if (shouldRecalibrateAlphaStrength({
        originalScore: beforeScore,
        processedScore: afterScore,
        suppressionGain: improvement
    })) {
        const originalNearBlackRatio = calculateNearBlackRatio(imageData, position);
        const recalibrated = recalibrateAlphaStrength({
            originalImageData: imageData,
            alphaMap,
            position,
            originalSpatialScore: beforeScore,
            processedSpatialScore: afterScore,
            originalNearBlackRatio
        });

        if (recalibrated) {
            finalImageData = recalibrated.imageData;
            afterScore = recalibrated.processedSpatialScore;
            improvement = recalibrated.suppressionGain;
            alphaGain = recalibrated.alphaGain;
            afterGradient = computeRegionGradientCorrelation({
                imageData: finalImageData,
                alphaMap,
                region: {
                    x: position.x,
                    y: position.y,
                    size: position.width
                }
            });
        }
    }

    if (afterScore <= 0.3 && afterGradient >= OUTLINE_REFINEMENT_THRESHOLD) {
        const originalNearBlackRatio = calculateNearBlackRatio(imageData, position);
        const refined = refineSubpixelOutline({
            originalImageData: imageData,
            alphaMap,
            position,
            alphaGain,
            originalNearBlackRatio,
            baselineSpatialScore: afterScore,
            baselineGradientScore: afterGradient
        });

        if (refined) {
            finalImageData = refined.imageData;
            alphaMap = refined.alphaMap;
            alphaGain = refined.alphaGain;
            afterScore = refined.spatialScore;
            afterGradient = refined.gradientScore;
            improvement = beforeScore - afterScore;
        }
    }

    const beforeBlackRatio = calculateNearBlackRatio(imageData, position);
    const afterBlackRatio = calculateNearBlackRatio(finalImageData, position);

    return {
        beforeScore,
        beforeGradient,
        afterScore,
        afterGradient,
        improvement,
        alphaGain,
        beforeBlackRatio,
        afterBlackRatio
    };
}

test('all sample assets should show strong watermark suppression after processing', async (t) => {
    const files = (await readdir(SAMPLE_DIR))
        .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
        .sort((a, b) => a.localeCompare(b));

    assert.ok(files.length > 0, 'samples directory should contain image files');

    let browser;
    try {
        browser = await chromium.launch({ headless: true });
    } catch (error) {
        if (isMissingPlaywrightExecutableError(error)) {
            t.skip('Playwright browser binaries are missing in this environment');
            return;
        }
        throw error;
    }

    const page = await browser.newPage();

    try {
        const alpha48 = calculateAlphaMap(await decodeImageDataInPage(page, BG48_PATH));
        const alpha96 = calculateAlphaMap(await decodeImageDataInPage(page, BG96_PATH));

        for (const fileName of files) {
            const filePath = path.join(SAMPLE_DIR, fileName);
            const imageData = await decodeImageDataInPage(page, filePath);
            const result = removeWatermarkLikeEngine(imageData, alpha48, alpha96);

            assert.ok(
                result.beforeScore >= 0.3,
                `${fileName}: expected watermark signal before processing >= 0.3, got ${result.beforeScore}`
            );
            assert.ok(
                result.afterScore < 0.22,
                `${fileName}: expected residual signal after processing < 0.22, got ${result.afterScore}`
            );
            assert.ok(
                result.improvement >= 0.35,
                `${fileName}: expected signal improvement >= 0.35, got ${result.improvement}`
            );
            if (result.alphaGain > 1) {
                assert.ok(
                    result.afterBlackRatio <= result.beforeBlackRatio + 0.05,
                    `${fileName}: alphaGain=${result.alphaGain} darkening too strong, beforeBlack=${result.beforeBlackRatio}, afterBlack=${result.afterBlackRatio}`
                );
            }
            if (result.afterScore < 0.22) {
                assert.ok(
                    result.afterGradient <= result.beforeGradient,
                    `${fileName}: expected outline gradient to not increase, before=${result.beforeGradient}, after=${result.afterGradient}`
                );
            }
        }
    } finally {
        await browser.close();
    }
});
