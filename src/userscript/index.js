import { WatermarkEngine } from '../core/watermarkEngine.js';
import { canvasToBlob } from '../core/canvasBlob.js';
import { isGeminiGeneratedAssetUrl, normalizeGoogleusercontentImageUrl } from './urlUtils.js';
import { toWorkerScriptUrl } from './trustedTypes.js';
import { shouldUseInlineWorker } from './runtimeFlags.js';
import {
  MAX_PROCESS_RETRIES,
  readRetryState,
  registerProcessFailure,
  resetRetryState,
  shouldProcessNow
} from './retryPolicy.js';

const USERSCRIPT_WORKER_CODE = typeof __US_WORKER_CODE__ === 'string' ? __US_WORKER_CODE__ : '';

let enginePromise = null;
let workerClient = null;
const processingQueue = new Set();
const retryTimers = new WeakMap();

const debounce = (func, wait) => {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
};

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = reject;
  img.src = src;
});

const canUseInlineWorker = () => shouldUseInlineWorker(USERSCRIPT_WORKER_CODE);

const toError = (errorLike, fallback = 'Inline worker error') => {
  if (errorLike instanceof Error) return errorLike;
  if (typeof errorLike === 'string' && errorLike.length > 0) return new Error(errorLike);
  if (errorLike && typeof errorLike.message === 'string' && errorLike.message.length > 0) {
    return new Error(errorLike.message);
  }
  return new Error(fallback);
};

class InlineWorkerClient {
  constructor(workerCode) {
    const blob = new Blob([workerCode], { type: 'text/javascript' });
    this.workerUrl = URL.createObjectURL(blob);
    const workerScriptUrl = toWorkerScriptUrl(this.workerUrl);
    if (!workerScriptUrl) {
      URL.revokeObjectURL(this.workerUrl);
      this.workerUrl = null;
      throw new Error('Trusted Types policy unavailable for inline worker');
    }
    try {
      this.worker = new Worker(workerScriptUrl);
    } catch (error) {
      URL.revokeObjectURL(this.workerUrl);
      this.workerUrl = null;
      throw error;
    }
    this.pending = new Map();
    this.requestId = 0;
    this.handleMessage = this.handleMessage.bind(this);
    this.handleError = this.handleError.bind(this);
    this.worker.addEventListener('message', this.handleMessage);
    this.worker.addEventListener('error', this.handleError);
  }

  dispose() {
    this.worker.removeEventListener('message', this.handleMessage);
    this.worker.removeEventListener('error', this.handleError);
    this.worker.terminate();
    if (this.workerUrl) {
      URL.revokeObjectURL(this.workerUrl);
      this.workerUrl = null;
    }
    const error = new Error('Inline worker disposed');
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pending.clear();
  }

  handleMessage(event) {
    const payload = event?.data;
    if (!payload || typeof payload.id === 'undefined') return;
    const pending = this.pending.get(payload.id);
    if (!pending) return;
    this.pending.delete(payload.id);
    clearTimeout(pending.timeoutId);
    if (payload.ok) {
      pending.resolve(payload.result);
      return;
    }
    pending.reject(new Error(payload.error?.message || 'Inline worker request failed'));
  }

  handleError(event) {
    const error = new Error(event?.message || 'Inline worker crashed');
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(type, payload, transferList = [], timeoutMs = 120000) {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Inline worker request timed out: ${type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeoutId });
      try {
        this.worker.postMessage({ id, type, ...payload }, transferList);
      } catch (error) {
        clearTimeout(timeoutId);
        this.pending.delete(id);
        reject(toError(error));
      }
    });
  }

  async processBlob(blob, options = {}) {
    const inputBuffer = await blob.arrayBuffer();
    const result = await this.request(
      'process-image',
      { inputBuffer, mimeType: blob.type || 'image/png', options },
      [inputBuffer]
    );
    return new Blob([result.processedBuffer], { type: result.mimeType || 'image/png' });
  }
}

const isValidGeminiImage = (img) => img.closest('generated-image,.generated-image-container') !== null;

const findGeminiImages = () =>
  [...document.querySelectorAll('img[src*="googleusercontent.com"]')].filter(isValidGeminiImage);

const fetchBlob = (url) => new Promise((resolve, reject) => {
  // use GM_xmlhttpRequest to fetch image blob to avoid cross-origin issue
  GM_xmlhttpRequest({
    method: 'GET',
    url,
    responseType: 'blob',
    onload: (response) => resolve(response.response),
    onerror: reject
  });
});

async function getEngine() {
  if (!enginePromise) {
    enginePromise = WatermarkEngine.create().catch((error) => {
      enginePromise = null;
      throw error;
    });
  }
  return enginePromise;
}

function disableInlineWorker(reason) {
  if (!workerClient) return;
  console.warn('[Gemini Watermark Remover] Disable worker path:', reason);
  workerClient.dispose();
  workerClient = null;
}

async function processBlobWithBestPath(blob, options = {}) {
  if (workerClient) {
    try {
      return await workerClient.processBlob(blob, options);
    } catch (error) {
      console.warn('[Gemini Watermark Remover] Worker path failed, fallback to main thread:', error);
      disableInlineWorker(error);
    }
  }

  const engine = await getEngine();
  const blobUrl = URL.createObjectURL(blob);
  try {
    const img = await loadImage(blobUrl);
    const canvas = await engine.removeWatermarkFromImage(img, options);
    return await canvasToBlob(canvas);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

function clearRetryTimer(imgElement) {
  const timerId = retryTimers.get(imgElement);
  if (timerId) {
    clearTimeout(timerId);
    retryTimers.delete(imgElement);
  }
}

function scheduleRetry(imgElement, delayMs) {
  clearRetryTimer(imgElement);
  const timerId = setTimeout(() => {
    retryTimers.delete(imgElement);
    if (!document.contains(imgElement)) return;
    processImage(imgElement);
  }, delayMs);
  retryTimers.set(imgElement, timerId);
}

async function processImage(imgElement) {
  if (imgElement?.dataset?.watermarkProcessed === 'true') return;
  const retryState = readRetryState(imgElement?.dataset);
  if (!shouldProcessNow(retryState)) return;
  if (processingQueue.has(imgElement)) return;

  processingQueue.add(imgElement);
  imgElement.dataset.watermarkProcessed = 'processing';

  const originalSrc = imgElement.src;
  try {
    imgElement.src = '';
    const normalSizeBlob = await fetchBlob(normalizeGoogleusercontentImageUrl(originalSrc));
    const processedBlob = await processBlobWithBestPath(normalSizeBlob, { adaptiveMode: 'always' });
    const previousObjectUrl = imgElement.dataset.watermarkObjectUrl;
    if (previousObjectUrl) {
      URL.revokeObjectURL(previousObjectUrl);
    }
    const objectUrl = URL.createObjectURL(processedBlob);
    imgElement.dataset.watermarkObjectUrl = objectUrl;
    imgElement.src = objectUrl;
    clearRetryTimer(imgElement);
    resetRetryState(imgElement.dataset);
    imgElement.dataset.watermarkProcessed = 'true';

    console.log('[Gemini Watermark Remover] Processed image');
  } catch (error) {
    const retry = registerProcessFailure(imgElement.dataset);
    imgElement.src = originalSrc;
    if (retry.exhausted) {
      clearRetryTimer(imgElement);
      imgElement.dataset.watermarkProcessed = 'failed';
      console.warn(
        `[Gemini Watermark Remover] Failed ${retry.failureCount} times, stop retrying to avoid resource leaks:`,
        error
      );
    } else {
      imgElement.dataset.watermarkProcessed = 'retrying';
      scheduleRetry(imgElement, retry.delayMs);
      console.warn(
        `[Gemini Watermark Remover] Failed to process image, retry ${retry.failureCount}/${MAX_PROCESS_RETRIES} in ${retry.delayMs}ms:`,
        error
      );
    }
  } finally {
    processingQueue.delete(imgElement);
  }
}

const processAllImages = () => {
  const images = findGeminiImages();
  if (images.length === 0) return;

  console.log(`[Gemini Watermark Remover] Found ${images.length} images to process`);
  images.forEach(processImage);
};

const setupMutationObserver = () => {
  new MutationObserver(debounce(processAllImages, 100))
    .observe(document.body, { childList: true, subtree: true });
  console.log('[Gemini Watermark Remover] MutationObserver active');
};

async function processImageBlob(blob) {
  return processBlobWithBestPath(blob, { adaptiveMode: 'always' });
}

// Intercept fetch requests to replace downloadable image with the watermark removed image
const { fetch: origFetch } = unsafeWindow;
unsafeWindow.fetch = async (...args) => {
  const input = args[0];
  const url = typeof input === 'string' ? input : input?.url;
  if (isGeminiGeneratedAssetUrl(url)) {
    console.log('[Gemini Watermark Remover] Intercepting:', url);

    const normalizedUrl = normalizeGoogleusercontentImageUrl(url);
    if (typeof input === 'string') {
      args[0] = normalizedUrl;
    } else if (typeof Request !== 'undefined' && input instanceof Request) {
      args[0] = new Request(normalizedUrl, input);
    } else {
      args[0] = normalizedUrl;
    }

    const response = await origFetch(...args);
    if (!response.ok) return response;

    try {
      const processedBlob = await processImageBlob(await response.blob());
      return new Response(processedBlob, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    } catch (error) {
      console.warn('[Gemini Watermark Remover] Processing failed:', error);
      return response;
    }
  }

  return origFetch(...args);
};

(async function init() {
  try {
    console.log('[Gemini Watermark Remover] Initializing...');
    if (canUseInlineWorker()) {
      try {
        workerClient = new InlineWorkerClient(USERSCRIPT_WORKER_CODE);
        console.log('[Gemini Watermark Remover] Worker acceleration enabled');
      } catch (workerError) {
        workerClient = null;
        console.warn('[Gemini Watermark Remover] Worker initialization failed, using main thread:', workerError);
      }
    }

    if (!workerClient) {
      // Warm up main-thread engine when worker acceleration is unavailable.
      getEngine().catch((error) => {
        console.warn('[Gemini Watermark Remover] Engine warmup failed:', error);
      });
    }

    processAllImages();
    setupMutationObserver();

    window.addEventListener('beforeunload', () => {
      disableInlineWorker('beforeunload');
    });

    console.log('[Gemini Watermark Remover] Ready');
  } catch (error) {
    console.error('[Gemini Watermark Remover] Initialization failed:', error);
  }
})();
