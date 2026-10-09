export function createMessage({ content, senderName = 'PC', type = 'text' }) {
  return { content, senderName, type, createdAt: new Date() };
}

export function remainingMinutes(expiresAt) {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 60000));
}
