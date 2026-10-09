export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

export function formatTime(date = new Date()) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function getMimeType(fileName = '', fileType = '') {
  if (fileType && fileType !== 'application/octet-stream') return fileType;
  const ext = (fileName || '').split('.').pop().toLowerCase();
  const map = {
    // Images
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', tiff: 'image/tiff', tif: 'image/tiff',
    heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', psd: 'image/vnd.adobe.photoshop',
    // Audio
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
    aac: 'audio/aac', opus: 'audio/opus', wma: 'audio/x-ms-wma',
    // Video
    mp4: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo',
    mov: 'video/quicktime', wmv: 'video/x-ms-wmv', flv: 'video/x-flv', m4v: 'video/mp4', '3gp': 'video/3gpp',
    // Documents & Text
    pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', rtf: 'application/rtf', epub: 'application/epub+zip',
    // Code / Data
    js: 'text/javascript', ts: 'text/plain', jsx: 'text/plain', tsx: 'text/plain', html: 'text/html', css: 'text/css',
    json: 'application/json', py: 'text/x-python', c: 'text/x-c', cpp: 'text/x-c++', h: 'text/x-c', java: 'text/x-java-source',
    php: 'text/x-php', rb: 'text/x-ruby', go: 'text/x-go', rs: 'text/x-rust', sh: 'text/x-sh', bat: 'text/plain',
    ps1: 'text/plain', sql: 'text/x-sql', xml: 'text/xml', yaml: 'text/yaml', yml: 'text/yaml', env: 'text/plain', log: 'text/plain',
    // Archives & Binaries
    zip: 'application/zip', rar: 'application/x-rar-compressed', '7z': 'application/x-7z-compressed',
    tar: 'application/x-tar', gz: 'application/gzip', bz2: 'application/x-bzip2', iso: 'application/x-iso9001-image',
    dmg: 'application/x-apple-diskimage', apk: 'application/vnd.android.package-archive', exe: 'application/x-msdownload',
    msi: 'application/x-msi', bin: 'application/octet-stream'
  };
  return map[ext] || fileType || 'application/octet-stream';
}

export function isImageFile(fileName = '', fileType = '') {
  const resolved = getMimeType(fileName, fileType);
  return resolved.startsWith('image/');
}

export function dataUrlToBlob(dataUrl, fallbackMime = 'application/octet-stream') {
  const parts = dataUrl.split(',');
  const header = parts[0];
  const base64 = parts[1];
  const match = header.match(/:(.*?);/);
  const mime = match ? match[1] : fallbackMime;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime || fallbackMime });
}

export function formatMessageText(content = '') {
  if (!content) return '';
  const escaped = String(content).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);
  const urlRegex = /(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi;
  return escaped.replace(urlRegex, match => {
    const href = match.startsWith('www.') ? `http://${match}` : match;
    return `<a href="${href}" class="chat-message-link" target="_blank" rel="noopener noreferrer" title="Open link in new tab">${match} <i data-lucide="external-link" class="link-icon"></i></a>`;
  });
}
