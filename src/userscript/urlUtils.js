function isGoogleusercontentHost(hostname) {
  return hostname === 'googleusercontent.com' || hostname.endsWith('.googleusercontent.com');
}

function hasGeminiAssetPath(pathname) {
  return /^\/rd-[^/]+\//.test(pathname);
}

export function isGeminiGeneratedAssetUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return false;
  try {
    const parsed = new URL(url);
    return isGoogleusercontentHost(parsed.hostname) && hasGeminiAssetPath(parsed.pathname);
  } catch {
    return false;
  }
}

export function normalizeGoogleusercontentImageUrl(url) {
  if (!isGeminiGeneratedAssetUrl(url)) return url;

  try {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const tailTransform = path.match(/=([^/?#=]+)$/);
    if (tailTransform && /^(?:s|w|h)\d+/i.test(tailTransform[1])) {
      const keepDownloadFlag = tailTransform[1].endsWith('-d') ? '-d' : '';
      parsed.pathname = `${path.slice(0, tailTransform.index)}=s0${keepDownloadFlag}`;
      return parsed.toString();
    }

    const sizeTransformAtTail = /=s\d+([^/]*)$/;
    if (sizeTransformAtTail.test(path)) {
      parsed.pathname = path.replace(sizeTransformAtTail, '=s0$1');
      return parsed.toString();
    }

    parsed.pathname = `${path}=s0`;
    return parsed.toString();
  } catch {
    return url;
  }
}
